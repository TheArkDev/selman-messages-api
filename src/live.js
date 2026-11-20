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
  await env.DB.prepare('DELETE FROM live_seen WHERE channel_id = ?').bind(id).run();
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

const SEEN_MS = 10 * 60 * 1000; // how long a "live" result is trusted when YouTube gives a bad answer

const FETCH_HEADERS = {
  'user-agent': UA,
  'accept-language': 'en-US,en;q=0.9',
  cookie: 'CONSENT=YES+1; SOCS=CAI',
};

/** A real YouTube page has this data in it; a consent / blocked page does not. */
const looksLikeYouTube = (html) => html.includes('ytInitialData') || html.includes('ytInitialPlayerResponse');

/** Is this one video still live? Returns 'live' | 'off' | 'unknown'. */
export async function verifyVideo(videoId, fetchFn = fetch) {
  try {
    const res = await fetchFn('https://www.youtube.com/watch?v=' + videoId, { headers: FETCH_HEADERS, redirect: 'follow' });
    if (!res.ok) return 'unknown';
    const html = await res.text();
    if (!html.includes('"videoDetails"')) return 'unknown'; // consent / blocked page
    return /"isLive":true/.test(html) ? 'live' : 'off';
  } catch (_) {
    return 'unknown';
  }
}

async function checkOne(env, ch, fetchFn) {
  const base = { id: ch.id, name: ch.name, channel_url: ch.url };
  const key = ch.url;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...base, ...hit.data };

  const make = (videoId, title) => ({
    live: true,
    video_id: videoId,
    title: title || null,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  });

  // 1. Ask YouTube. state: 'live' | 'off' | 'unknown' (YouTube gave us a bad page).
  let state = 'unknown';
  let found = null;
  try {
    const path = normaliseChannel(ch.url).path;
    const res = await fetchFn('https://www.youtube.com' + path + '/live', { headers: FETCH_HEADERS, redirect: 'follow' });
    if (res.ok) {
      const html = await res.text();
      const p = parseLivePage(html);
      if (p.live) {
        state = 'live';
        found = p;
      } else if (looksLikeYouTube(html)) {
        state = 'off';
      }
    }
  } catch (_) {}

  if (state === 'live') {
    const data = make(found.video_id, found.title);
    await env.DB.prepare(
      'INSERT INTO live_seen (channel_id, video_id, title, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET video_id = excluded.video_id, title = excluded.title, seen_at = excluded.seen_at'
    ).bind(ch.id, data.video_id, data.title, Date.now()).run();
    cache.set(key, { at: Date.now(), data });
    return { ...base, ...data };
  }

  // 2. Not live (or unknown). If we saw it live a moment ago, don't flip off on one
  //    answer: check that same video directly, and only switch off if it has really ended.
  const seen = await env.DB.prepare('SELECT video_id, title, seen_at FROM live_seen WHERE channel_id = ?').bind(ch.id).first();
  if (seen && Date.now() - seen.seen_at < SEEN_MS) {
    const v = await verifyVideo(seen.video_id, fetchFn);
    if (v !== 'off') {
      const data = make(seen.video_id, seen.title);
      cache.set(key, { at: Date.now(), data });
      return { ...base, ...data };
    }
  }
  if (seen) await env.DB.prepare('DELETE FROM live_seen WHERE channel_id = ?').bind(ch.id).run();

  const off = { live: false, video_id: null, title: null, thumbnail: null };
  if (state === 'off') {
    cache.set(key, { at: Date.now(), data: off });
    return { ...base, ...off };
  }
  // Unknown and nothing recent: say "not live" but flag it, and don't cache it.
  return { ...base, ...off, error: true };
}

/** Every saved channel with its live state, checked in parallel. */
export async function liveAll(env, fetchFn = fetch) {
  const rows = await listChannels(env);
  const channels = await Promise.all(rows.map((r) => checkOne(env, r, fetchFn)));
  channels.sort((a, b) => Number(b.live) - Number(a.live)); // live ones first (stable)
  return { channels };
}
