import { handleAdmin } from './admin.js';
import { handleAuth } from './auth.js';
import { ensureSchema } from './schema.js';
import { liveAll } from './live.js';
import { activeNotices } from './notices.js';
import { privacyPage, deleteAccountPage } from './privacy.js';
import { runLiveAlerts } from './alerts.js';

// Selman Messages API - Cloudflare Worker
// D1 holds the metadata, R2 holds the audio and images.
//
//   GET /api/home                      -> { featured: [...], suggested: [...] }
//   GET /api/speakers?category=mog     -> folders for MOG | songs | prayer
//   GET /api/speakers/:id/items        -> everything inside one folder
//   GET /api/search?q=faith            -> messages whose title, speaker or series match
//   GET /api/notices                   -> current announcements
//   GET /api/live                      -> every live channel and whether it is streaming now
//   POST /api/items/:id/play           -> counts one listen

const CATEGORIES = new Set(['mog', 'songs', 'prayer']);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(data, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': maxAge > 0 ? `public, max-age=${maxAge}` : 'no-store',
    },
  });
}

function mediaUrl(env, key) {
  if (!key) return null;
  const base = env.MEDIA_BASE_URL.replace(/\/$/, '');
  return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function mapSpeaker(env, r) {
  return {
    id: r.id,
    category: r.category,
    name: r.name,
    image_url: mediaUrl(env, r.image_key),
    glow: r.glow,
    count: r.count ?? 0,
  };
}

function mapTrack(env, r) {
  return {
    id: r.id,
    speaker_id: r.speaker_id,
    speaker_name: r.speaker_name,
    category: r.category,
    title: r.title,
    audio_url: mediaUrl(env, r.audio_key),
    image_url: mediaUrl(env, r.image_key || r.speaker_image_key),
    duration_sec: r.duration_sec || 0,
    glow: r.speaker_glow || null,
    preached_on: r.preached_on || null,
    series: r.series || null,
    description: r.description || null,
  };
}

// ---- deterministic daily shuffle -------------------------------------------
function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Day key in Kenya time (UTC+3) so the picks change at local midnight.
function dayKey() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

// Pick `n` items, one per speaker per round, so the carousel is mixed.
function pickMixed(rows, n, rand) {
  const bySpeaker = new Map();
  for (const r of rows) {
    if (!bySpeaker.has(r.speaker_id)) bySpeaker.set(r.speaker_id, []);
    bySpeaker.get(r.speaker_id).push(r);
  }
  const groups = shuffle([...bySpeaker.values()].map((g) => shuffle(g, rand)), rand);
  const picked = [];
  let round = 0;
  while (picked.length < n && groups.some((g) => g.length > round)) {
    for (const g of groups) {
      if (g.length > round && picked.length < n) picked.push(g[round]);
    }
    round++;
  }
  return picked;
}

const TRACK_SELECT = `
  SELECT i.*, s.name AS speaker_name, s.image_key AS speaker_image_key, s.glow AS speaker_glow
  FROM items i JOIN speakers s ON s.id = i.speaker_id`;

// ---- handlers ----------------------------------------------------------------
async function handleHome(env) {
  const { results } = await env.DB.prepare(
    `${TRACK_SELECT} WHERE i.category = 'mog' ORDER BY i.id LIMIT 2000`
  ).all();

  const day = dayKey();
  const featured = pickMixed(results, 6, mulberry32(hashString(`featured-${day}`)));
  const used = new Set(featured.map((r) => r.id));
  const rest = results.filter((r) => !used.has(r.id));
  const suggested = shuffle(rest, mulberry32(hashString(`suggested-${day}`))).slice(0, 20);

  return json(
    {
      date: day,
      featured: featured.map((r) => mapTrack(env, r)),
      suggested: suggested.map((r) => mapTrack(env, r)),
    },
    200,
    600
  );
}

async function handleSpeakers(env, category) {
  if (!CATEGORIES.has(category)) return json({ error: 'Unknown category' }, 400);
  const { results } = await env.DB.prepare(
    `SELECT s.*, COUNT(i.id) AS count
     FROM speakers s LEFT JOIN items i ON i.speaker_id = s.id
     WHERE s.category = ?
     GROUP BY s.id
     ORDER BY s.sort, s.name`
  )
    .bind(category)
    .all();
  return json(results.map((r) => mapSpeaker(env, r)), 200, 300);
}

async function handleItems(env, speakerId) {
  const { results } = await env.DB.prepare(
    `${TRACK_SELECT} WHERE i.speaker_id = ?
     ORDER BY COALESCE(NULLIF(i.preached_on, ''), substr(i.published_at, 1, 10)) DESC, i.published_at DESC, i.title`
  )
    .bind(speakerId)
    .all();
  return json(results.map((r) => mapTrack(env, r)), 200, 300);
}


function likeEscape(t) {
  return t.replace(/[\\%_]/g, (c) => '\\' + c);
}

async function handleSearch(env, q) {
  const terms = String(q || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .map((t) => t.slice(0, 40));
  if (terms.length === 0 || terms.join('').length < 2) return json([], 200, 60);
  const where = terms
    .map(
      () =>
        `(LOWER(i.title) LIKE ? ESCAPE '\\' OR LOWER(s.name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(i.series, '')) LIKE ? ESCAPE '\\')`
    )
    .join(' AND ');
  const binds = terms.flatMap((t) => {
    const p = `%${likeEscape(t)}%`;
    return [p, p, p];
  });
  const { results } = await env.DB.prepare(
    `${TRACK_SELECT} WHERE ${where} ORDER BY i.plays DESC, i.published_at DESC, i.title LIMIT 60`
  )
    .bind(...binds)
    .all();
  return json(results.map((r) => mapTrack(env, r)), 200, 60);
}

async function handlePlay(env, id) {
  if (!id || id.length > 120) return json({ error: 'Bad request' }, 400);
  await env.DB.prepare('UPDATE items SET plays = plays + 1 WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const first = new URL(request.url).pathname;
    if (first.startsWith('/admin')) return handleAdmin(request, env);
    if (first === '/privacy') return privacyPage(env);
    if (first === '/delete-account') return deleteAccountPage(env);
    if (first === '/api/health') {
      // Shows only yes/no for each setting, never the values.
      return json({
        ok: true,
        database: !!env.DB,
        media_bucket: !!env.MEDIA,
        secret: !!(env.AUTH_SECRET || env.ADMIN_PASSWORD),
        push: !!env.FCM_SERVICE_ACCOUNT,
        admin_emails: String(env.ADMIN_EMAILS || '').split(',').some((e) => e.trim()),
      });
    }
    if (first.startsWith('/api/auth/')) return handleAuth(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    // The only public write: counting a listen.
    const playMatch = path.match(/^\/api\/items\/([^/]+)\/play$/);
    if (playMatch && request.method === 'POST') {
      try {
        await ensureSchema(env);
        return await handlePlay(env, decodeURIComponent(playMatch[1]));
      } catch (e) {
        return json({ error: 'Server error' }, 500);
      }
    }
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    try {
      if (path !== '' && path !== '/') await ensureSchema(env);
      if (path === '/api/home') return await handleHome(env);
      if (path === '/api/live') return json(await liveAll(env), 200, 30);
      if (path === '/api/notices') return json(await activeNotices(env), 200, 60);
      if (path === '/api/search') return await handleSearch(env, url.searchParams.get('q'));
      if (path === '/api/speakers') {
        return await handleSpeakers(env, url.searchParams.get('category') || 'mog');
      }
      const m = path.match(/^\/api\/speakers\/([^/]+)\/items$/);
      if (m) return await handleItems(env, decodeURIComponent(m[1]));
      if (path === '' || path === '/') return json({ ok: true, name: 'selman-api' });
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: 'Server error' }, 500);
    }
  },

  // Runs every couple of minutes (see wrangler.toml): alerts people when a channel goes live.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runLiveAlerts(env).catch(() => {}));
  },
};
