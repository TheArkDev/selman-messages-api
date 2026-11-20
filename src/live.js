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

const MAX_CHANNELS = 20;

function newId() {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return 'lc-' + [...b].map((x) => (x % 36).toString(36)).join('');
}

export async function listChannels(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, name, url FROM live_channels ORDER BY sort, name COLLATE NOCASE'
  ).all();
  return results || [];
}

/** Adds or updates one ministry. Returns the saved row or { error }. */
export async function saveChannel(env, body) {
  const name = String((body && body.name) || '').trim().slice(0, 80);
  if (!name) return { error: 'Please enter the ministry name' };
  const ch = normaliseChannel(body && body.url);
  if (!ch) return { error: 'That is not a YouTube channel link. Use a link like https://www.youtube.com/@channelname' };

  const id = body && body.id ? String(body.id) : '';
  if (id) {
    const r = await env.DB.prepare('UPDATE live_channels SET name = ?, url = ? WHERE id = ?').bind(name, ch.url, id).run();
    cache.clear();
    return { id, name, url: ch.url, updated: r };
  }
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM live_channels').first();
  if (n && n.n >= MAX_CHANNELS) return { error: `You can add up to ${MAX_CHANNELS} channels` };
  const dup = await env.DB.prepare('SELECT id FROM live_channels WHERE url = ?').bind(ch.url).first();
  if (dup) return { error: 'That channel is already in the list' };
  const nid = newId();
  await env.DB.prepare('INSERT INTO live_channels (id, name, url, sort) VALUES (?, ?, ?, ?)')
    .bind(nid, name, ch.url, Date.now() % 1000000000)
    .run();
  cache.clear();
  return { id: nid, name, url: ch.url };
}

export async function deleteChannel(env, id) {
  await env.DB.prepare('DELETE FROM live_channels WHERE id = ?').bind(id).run();
  cache.clear();
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

async function checkOne(ch, fetchFn) {
  const base = { id: ch.id, name: ch.name, channel_url: ch.url };
  const key = ch.url;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...base, ...hit.data };
  try {
    const path = normaliseChannel(ch.url).path;
    const res = await fetchFn('https://www.youtube.com' + path + '/live', {
      headers: {
        'user-agent': UA,
        'accept-language': 'en-US,en;q=0.9',
        cookie: 'CONSENT=YES+1; SOCS=CAI',
      },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('status ' + res.status);
    const p = parseLivePage(await res.text());
    const data = {
      live: p.live,
      video_id: p.video_id || null,
      title: p.title || null,
      thumbnail: p.video_id ? `https://i.ytimg.com/vi/${p.video_id}/hqdefault.jpg` : null,
    };
    cache.set(key, { at: Date.now(), data });
    return { ...base, ...data };
  } catch (e) {
    // A failure is not cached; the channel just shows as "not live" until the next check.
    return { ...base, live: false, video_id: null, title: null, thumbnail: null, error: true };
  }
}

/** Every saved channel with its live state, checked in parallel. */
export async function liveAll(env, fetchFn = fetch) {
  const rows = await listChannels(env);
  const channels = await Promise.all(rows.map((r) => checkOne(r, fetchFn)));
  channels.sort((a, b) => Number(b.live) - Number(a.live)); // live ones first (stable)
  return { channels };
}
