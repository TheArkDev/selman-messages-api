// Live tab support: remembers the YouTube channel and tells the app whether
// that channel is streaming right now (and which video to play).
//
// No YouTube API key is needed. The Worker opens the channel's public
// ".../live" page, which points at the running stream when there is one.

const UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const CACHE_MS = 45 * 1000;
const cache = new Map(); // channel path -> { at, data }

/** Accepts a channel link or @handle. Returns { path, url } or null. */
export function normaliseChannel(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (/^@[\w.\-]+$/.test(s)) s = 'https://www.youtube.com/' + s;
  if (/^(www\.|m\.)?youtube\.com\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    return null;
  }
  if (!/^(www\.|m\.)?youtube\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/(@[\w.\-]+|channel\/UC[\w-]{20,}|c\/[\w.\-]+|user\/[\w.\-]+)/);
  if (!m) return null;
  return { path: '/' + m[1], url: 'https://www.youtube.com/' + m[1] };
}

export async function getChannel(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'live_channel'").first();
  return row && row.value ? normaliseChannel(row.value) : null;
}

export async function setChannel(env, input) {
  const raw = String(input || '').trim();
  if (!raw) {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'live_channel'").run();
    cache.clear();
    return null;
  }
  const ch = normaliseChannel(raw);
  if (!ch) return undefined; // not a usable YouTube channel link
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('live_channel', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(ch.url)
    .run();
  cache.clear();
  return ch;
}

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Looks at the channel's /live page. Exported so it can be tested. */
export function parseLivePage(html) {
  const canon = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/);
  const isLive = /"isLive":true/.test(html);
  if (!canon || !isLive) return { live: false };
  const t = html.match(/<meta property="og:title" content="([^"]*)"/);
  return { live: true, video_id: canon[1], title: t ? decode(t[1]) : '' };
}

export async function liveStatus(env, fetchFn = fetch) {
  const ch = await getChannel(env);
  if (!ch) return { configured: false, live: false };

  const hit = cache.get(ch.path);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  let data;
  try {
    const res = await fetchFn('https://www.youtube.com' + ch.path + '/live', {
      headers: {
        'user-agent': UA,
        'accept-language': 'en-US,en;q=0.9',
        cookie: 'CONSENT=YES+1; SOCS=CAI',
      },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('status ' + res.status);
    const p = parseLivePage(await res.text());
    data = {
      configured: true,
      channel_url: ch.url,
      live: p.live,
      video_id: p.video_id || null,
      title: p.title || null,
      thumbnail: p.video_id ? `https://i.ytimg.com/vi/${p.video_id}/hqdefault.jpg` : null,
      checked_at: new Date().toISOString(),
    };
  } catch (e) {
    // Don't cache a failure; report "not live" and let the app retry later.
    return { configured: true, channel_url: ch.url, live: false, video_id: null, title: null, thumbnail: null, error: true };
  }
  cache.set(ch.path, { at: Date.now(), data });
  return data;
}
