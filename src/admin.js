// Admin API for The Message.
// Served under /admin (page) and /admin/api/* (JSON). Everything except the
// page itself and /login needs a valid token.
//
// Needs: env.DB (D1), env.MEDIA (R2 bucket binding), env.ADMIN_PASSWORD (secret).

import { ADMIN_HTML } from './admin-page.js';
import { secretOf, hmac, safeEqual, signToken, verifyToken, bearer, isAdminSubject, adminListUsers, adminResetPassword, adminUserCount } from './auth.js';
import { ensureSchema } from './schema.js';
import { listChannels, saveChannel, deleteChannel } from './live.js';
import { allNotices, saveNotice, deleteNotice } from './notices.js';
import { sendToTopic, pushReady } from './push.js';

const CATEGORIES = new Set(['mog', 'songs', 'prayer']);
const AUDIO_TYPES = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
};
const IMAGE_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
const fail = (msg, status = 400) => json({ error: msg }, status);

const WEB_TOKEN_TTL_MS = 12 * 3600 * 1000;

// ---- helpers ---------------------------------------------------------------
function slug(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function rand(n = 6) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => (x % 36).toString(36)).join('');
}

function ext(filename) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

function titleFromFilename(name) {
  return String(name || '')
    .replace(/\.[a-zA-Z0-9]+$/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Turns a file name (or a title that came from one) into just the message
// title: drops the speaker's name, honorifics, track numbers, website names
// and tags like "(Official Audio)".
const HONORIFICS = '(?:apostle|apst|bishop|pastor|pst|rev(?:erend)?|prophet|dr|doctor|evangelist|ev|elder|minister|mr|mrs|ps)';
function escRe(x) {
  return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function cleanTitle(raw, speakerName) {
  let t = titleFromFilename(raw);
  t = t.replace(/[–—]/g, '-');

  // website names and links
  t = t.replace(/https?:\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' ').replace(/\b[\w-]+\.(?:com|net|org|co|ng|ke|info|tv|fm)\b/gi, ' ');
  // tags in brackets that are only labels
  t = t.replace(/[\(\[]\s*(?:official|audio|video|lyrics?|hd|mp3|full|new|free download|download)[^\)\]]*[\)\]]/gi, ' ');

  // the speaker's name, in full and by parts (keeps parts of 3+ letters)
  const name = String(speakerName || '')
    .replace(new RegExp('\\b' + HONORIFICS + '\\b\\.?', 'gi'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = name.split(' ').filter((w) => w.length >= 3);
  const variants = [];
  if (name) variants.push(name);
  if (words.length > 1) variants.push(words.join(' '));
  for (const v of variants.sort((a, b) => b.length - a.length)) {
    t = t.replace(new RegExp(escRe(v).replace(/\s+/g, '[\\s._-]+'), 'gi'), ' ');
  }
  // leftover honorific + surname, e.g. "Apostle Selman" or "Bishop Oyedepo"
  for (const w of words) {
    t = t.replace(new RegExp('\\b' + HONORIFICS + '\\.?\\s+' + escRe(w) + '\\b', 'gi'), ' ');
    t = t.replace(new RegExp('(^|[\\s-])' + escRe(w) + '(?=$|[\\s-])', 'gi'), ' ');
  }
  t = t.replace(new RegExp('\\b' + HONORIFICS + '\\b\\.?(?=\\s*(?:-|$))', 'gi'), ' ');

  // leading track numbers: "01 ", "02.", "3) "
  t = t.replace(/^\s*\d{1,3}\s*[.)\-_]\s*/, ' ');
  // separators left at the ends or doubled
  t = t.replace(/\s*-\s*(?:-\s*)+/g, ' - ').replace(/^[\s\-|:,._]+|[\s\-|:,._]+$/g, '');
  t = t.replace(/\(\s*\)|\[\s*\]/g, ' ').replace(/\s+/g, ' ').trim();
  return t || titleFromFilename(raw);
}

// Same title in the same folder? Ignores case, spaces and punctuation.
function sameTitleKey(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
async function existingTitle(env, sp, title) {
  const key = sameTitleKey(title);
  if (!key) return null;
  const { results } = await env.DB.prepare('SELECT title FROM items WHERE speaker_id = ?').bind(sp.id).all();
  for (const r of results || []) {
    if (sameTitleKey(r.title) === key || sameTitleKey(cleanTitle(r.title, sp.name)) === key) return r.title;
  }
  return null;
}

function validColor(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
}

// Keys must stay inside the folders the app uses.
function allowedKey(key) {
  return (
    typeof key === 'string' &&
    key.length < 300 &&
    !key.includes('..') &&
    /^(mog|songs|prayer)\/[a-z0-9-]+\/[^/]+$/.test(key)
  );
}

async function getSpeaker(env, id) {
  return env.DB.prepare('SELECT * FROM speakers WHERE id = ?').bind(id).first();
}

// ---- handlers --------------------------------------------------------------
async function listSpeakers(env, category) {
  if (!CATEGORIES.has(category)) return fail('Unknown category');
  const { results } = await env.DB.prepare(
    `SELECT s.*, COUNT(i.id) AS count
     FROM speakers s LEFT JOIN items i ON i.speaker_id = s.id
     WHERE s.category = ? GROUP BY s.id ORDER BY s.sort, s.name`
  )
    .bind(category)
    .all();
  const base = env.MEDIA_BASE_URL.replace(/\/$/, '');
  return json(
    results.map((r) => ({
      ...r,
      image_url: r.image_key ? `${base}/${r.image_key.split('/').map(encodeURIComponent).join('/')}` : null,
    }))
  );
}

async function saveSpeaker(request, env) {
  const b = await request.json().catch(() => null);
  if (!b) return fail('Invalid request');
  const name = String(b.name || '').trim();
  if (!name || name.length > 80) return fail('Name is required (max 80 characters)');
  if (!CATEGORIES.has(b.category)) return fail('Unknown category');
  const glow = validColor(b.glow) ? b.glow.toUpperCase() : '#FFC107';
  const sort = Number.isFinite(Number(b.sort)) ? Math.trunc(Number(b.sort)) : 100;
  const bio = String(b.bio || '').trim().slice(0, 800);

  if (b.id) {
    const existing = await getSpeaker(env, String(b.id));
    if (!existing) return fail('Folder not found', 404);
    // A bio only changes when the app sends one (older app versions leave it alone).
    await env.DB.prepare('UPDATE speakers SET name = ?, glow = ?, sort = ?, bio = CASE WHEN ? THEN ? ELSE bio END WHERE id = ?')
      .bind(name, glow, sort, 'bio' in b ? 1 : 0, bio || null, existing.id)
      .run();
    return json({ id: existing.id });
  }

  let id = slug(name) || 'folder';
  if (await getSpeaker(env, id)) id = `${id}-${rand(4)}`;
  await env.DB.prepare(
    'INSERT INTO speakers (id, category, name, image_key, glow, sort, bio) VALUES (?, ?, ?, NULL, ?, ?, ?)'
  )
    .bind(id, b.category, name, glow, sort, bio || null)
    .run();
  return json({ id });
}

// Saves the folder order the admin dragged into: ids come in the order they should appear.
async function reorderSpeakers(request, env) {
  const b = await request.json().catch(() => null);
  if (!b || !CATEGORIES.has(b.category) || !Array.isArray(b.ids) || b.ids.length > 200) return fail('Invalid request');
  let i = 0;
  for (const raw of b.ids) {
    i += 10;
    await env.DB.prepare('UPDATE speakers SET sort = ? WHERE id = ? AND category = ?')
      .bind(i, String(raw), b.category)
      .run();
  }
  return json({ ok: true });
}

async function deleteSpeaker(env, id) {
  const sp = await getSpeaker(env, id);
  if (!sp) return fail('Folder not found', 404);
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE speaker_id = ?').bind(id).first();
  if (row && row.n > 0) return fail('Delete the items inside this folder first');
  if (sp.image_key) await env.MEDIA.delete(sp.image_key);
  await env.DB.prepare('DELETE FROM speakers WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

async function uploadPhoto(request, env, id) {
  const sp = await getSpeaker(env, id);
  if (!sp) return fail('Folder not found', 404);
  const e = ext(new URL(request.url).searchParams.get('filename') || '');
  const type = IMAGE_TYPES[e];
  if (!type) return fail('Photo must be jpg, png or webp');
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return fail('Empty file');
  if (body.byteLength > MAX_PHOTO_BYTES) return fail('Photo is too large (max 8 MB)');

  // New key each time so the app does not keep showing a cached old photo.
  const key = `speakers/${sp.id}-${Date.now().toString(36)}.${e === 'jpeg' ? 'jpg' : e}`;
  await env.MEDIA.put(key, body, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000' } });
  await env.DB.prepare('UPDATE speakers SET image_key = ? WHERE id = ?').bind(key, sp.id).run();
  if (sp.image_key && sp.image_key !== key) await env.MEDIA.delete(sp.image_key);
  return json({ ok: true, image_key: key });
}

async function listItems(env, speakerId) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, duration_sec, published_at, preached_on, series, description, plays FROM items WHERE speaker_id = ?
     ORDER BY COALESCE(NULLIF(preached_on, ''), substr(published_at, 1, 10)) DESC, published_at DESC, title`
  )
    .bind(speakerId)
    .all();
  return json(results);
}

async function renameItem(request, env, id) {
  const b = await request.json().catch(() => null);
  if (!b) return fail('Invalid request');
  const sets = [];
  const vals = [];
  if ('title' in b) {
    const title = String(b.title || '').trim();
    if (!title || title.length > 200) return fail('Title is required (max 200 characters)');
    sets.push('title = ?');
    vals.push(title);
  }
  if ('preached_on' in b) {
    const d = String(b.preached_on || '').trim();
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return fail('Date must look like 2024-03-17');
    if (d) {
      const dt = new Date(d + 'T00:00:00Z');
      if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== d) return fail('That date does not exist');
    }
    sets.push('preached_on = ?');
    vals.push(d || null);
  }
  if ('series' in b) {
    const t = String(b.series || '').trim();
    if (t.length > 80) return fail('Series is too long (max 80 characters)');
    sets.push('series = ?');
    vals.push(t || null);
  }
  if ('description' in b) {
    const t = String(b.description || '').trim();
    if (t.length > 1000) return fail('Description is too long (max 1000 characters)');
    sets.push('description = ?');
    vals.push(t || null);
  }
  // Move to another folder. Only the database row changes: the audio stays at
  // the same R2 key and the item keeps its id, so listeners' favourites,
  // playlists and downloads carry on working.
  if ('speaker_id' in b) {
    const target = await getSpeaker(env, String(b.speaker_id || ''));
    if (!target) return fail('Folder not found', 404);
    const cur = await env.DB.prepare('SELECT id, title, speaker_id FROM items WHERE id = ?').bind(id).first();
    if (!cur) return fail('Item not found', 404);
    if (cur.speaker_id !== target.id) {
      const finalTitle = 'title' in b ? String(b.title || '').trim() : cur.title;
      const dupe = await existingTitle(env, target, finalTitle);
      if (dupe) return fail(`Already uploaded: "${dupe}" is in ${target.name}'s folder`, 409);
      sets.push('speaker_id = ?', 'category = ?');
      vals.push(target.id, target.category);
    }
  }
  if (sets.length === 0) return 'speaker_id' in b ? json({ ok: true }) : fail('Nothing to change');
  await env.DB.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
  return json({ ok: true });
}

// Day key in Kenya time (UTC+3), n days ago. Matches the keys the app's listens are stored under.
function kenyaDay(daysAgo = 0) {
  return new Date(Date.now() + 3 * 3600 * 1000 - daysAgo * 86400 * 1000).toISOString().slice(0, 10);
}

async function stats(env) {
  const totals = await env.DB.prepare(
    'SELECT COUNT(*) AS items, COALESCE(SUM(plays), 0) AS plays FROM items'
  ).first();
  const sp = await env.DB.prepare('SELECT COUNT(*) AS n FROM speakers').first();
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.title, i.plays, s.name AS speaker_name
     FROM items i JOIN speakers s ON s.id = i.speaker_id
     WHERE i.plays > 0 ORDER BY i.plays DESC, i.title LIMIT 10`
  ).all();

  // Trends. Each part is optional so one failure never hides the basic totals.
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(kenyaDay(i));
  let daily = days.map((day) => ({ day, plays: 0 }));
  let trending = [];
  let byCategory = [];
  let topFolders = [];
  let neverPlayed = null;
  let newUsers7 = null;
  try {
    const d = await env.DB.prepare('SELECT day, SUM(plays) AS plays FROM play_daily WHERE day >= ? GROUP BY day')
      .bind(days[0])
      .all();
    const m = new Map((d.results || []).map((r) => [r.day, r.plays]));
    daily = days.map((day) => ({ day, plays: m.get(day) || 0 }));

    const t = await env.DB.prepare(
      `SELECT i.id, i.title, s.name AS speaker_name, SUM(d.plays) AS plays
       FROM play_daily d JOIN items i ON i.id = d.item_id JOIN speakers s ON s.id = i.speaker_id
       WHERE d.day >= ? GROUP BY i.id ORDER BY plays DESC, i.title LIMIT 5`
    )
      .bind(days[7])
      .all();
    trending = t.results || [];

    const c = await env.DB.prepare(
      'SELECT category AS name, COALESCE(SUM(plays), 0) AS plays, COUNT(*) AS items FROM items GROUP BY category ORDER BY plays DESC'
    ).all();
    byCategory = c.results || [];

    const f = await env.DB.prepare(
      `SELECT s.name AS name, COALESCE(SUM(i.plays), 0) AS plays, COUNT(i.id) AS items
       FROM speakers s LEFT JOIN items i ON i.speaker_id = s.id
       GROUP BY s.id ORDER BY plays DESC, s.name LIMIT 5`
    ).all();
    topFolders = f.results || [];

    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE plays = 0').first();
    neverPlayed = n ? n.n : null;

    const u = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= datetime('now', '-7 days')").first();
    newUsers7 = u ? u.n : null;
  } catch (e) {
    /* keep whatever was gathered */
  }

  return json({
    items: totals ? totals.items : 0,
    plays: totals ? totals.plays : 0,
    folders: sp ? sp.n : 0,
    users: await adminUserCount(env),
    top: results,
    daily,
    trending,
    by_category: byCategory,
    top_folders: topFolders,
    never_played: neverPlayed,
    new_users_7d: newUsers7,
  });
}

// Sends ONE alert after a batch of uploads finishes (the app calls this once per
// folder per batch, so listeners are not buzzed for every file).
async function announceNew(request, env) {
  const b = await request.json().catch(() => null);
  if (!b) return fail('Invalid request');
  const sp = await getSpeaker(env, String(b.speaker_id || ''));
  if (!sp) return fail('Folder not found', 404);
  if (!pushReady(env)) return fail('Push is not set up yet: the FCM_SERVICE_ACCOUNT secret is missing on the Worker.', 503);

  const ids = Array.isArray(b.item_ids) ? b.item_ids.slice(0, 500).map(String) : [];
  const count = Math.max(1, ids.length || Math.trunc(Number(b.count) || 1));
  const noun = sp.category === 'songs' ? 'song' : sp.category === 'prayer' ? 'prayer' : 'message';
  let body = 'Tap to listen';
  if (count === 1 && ids[0]) {
    const it = await env.DB.prepare('SELECT title FROM items WHERE id = ? AND speaker_id = ?').bind(ids[0], sp.id).first();
    if (it && it.title) body = it.title.slice(0, 120);
  }
  const title = count > 1 ? `${count} new ${noun}s from ${sp.name}` : `New ${noun} from ${sp.name}`;
  const r = await sendToTopic(env, 'new', title, body, { type: 'new', speaker_id: sp.id, category: sp.category });
  return r.ok ? json({ ok: true }) : fail(r.error, 502);
}

async function resetUser(env, id) {
  const r = await adminResetPassword(env, id);
  if (!r) return fail('Account not found', 404);
  return json(r);
}

async function deleteItem(env, id) {
  const it = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  if (!it) return fail('Item not found', 404);
  await env.MEDIA.delete(it.audio_key);
  if (it.image_key) await env.MEDIA.delete(it.image_key);
  await env.DB.prepare('DELETE FROM items WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// Multipart upload so large sermons never hit a request size limit.
async function uploadStart(request, env) {
  const b = await request.json().catch(() => null);
  if (!b) return fail('Invalid request');
  const sp = await getSpeaker(env, String(b.speaker_id || ''));
  if (!sp) return fail('Folder not found', 404);
  const e = ext(b.filename);
  const type = AUDIO_TYPES[e];
  if (!type) return fail('Audio must be mp3, m4a, aac, wav, ogg or opus');
  const dupe = await existingTitle(env, sp, cleanTitle(b.filename, sp.name));
  if (dupe) return fail(`Already uploaded: "${dupe}" is in ${sp.name}'s folder`, 409);
  const base = slug(cleanTitle(b.filename, sp.name)) || 'audio';
  const key = `${sp.category}/${sp.id}/${rand(6)}-${base}.${e}`;
  const mp = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: type } });
  return json({ key, uploadId: mp.uploadId });
}

// Checks a batch of file names BEFORE anything is uploaded, using the same title
// cleaning as the upload itself. Reasons:
//   folder    - already in this folder (the upload would be refused)
//   selection - the same title appears twice in this batch (the second would be refused)
//   other     - the same title exists in a different folder (allowed, but worth a look)
async function uploadCheck(request, env) {
  const b = await request.json().catch(() => null);
  if (!b || !Array.isArray(b.filenames) || b.filenames.length > 300) return fail('Invalid request');
  const sp = await getSpeaker(env, String(b.speaker_id || ''));
  if (!sp) return fail('Folder not found', 404);

  const mine = new Map();
  const own = await env.DB.prepare('SELECT title FROM items WHERE speaker_id = ?').bind(sp.id).all();
  for (const r of own.results || []) {
    mine.set(sameTitleKey(r.title), r.title);
    mine.set(sameTitleKey(cleanTitle(r.title, sp.name)), r.title);
  }
  const elsewhere = new Map();
  const rest = await env.DB.prepare(
    'SELECT i.title, s.name AS speaker_name FROM items i JOIN speakers s ON s.id = i.speaker_id WHERE i.speaker_id != ?'
  )
    .bind(sp.id)
    .all();
  for (const r of rest.results || []) {
    const k = sameTitleKey(r.title);
    if (k && !elsewhere.has(k)) elsewhere.set(k, r.speaker_name);
  }

  const seen = new Set();
  const duplicates = [];
  b.filenames.forEach((name, index) => {
    const k = sameTitleKey(cleanTitle(String(name || ''), sp.name));
    if (!k) return;
    const twice = seen.has(k);
    seen.add(k);
    if (mine.has(k)) duplicates.push({ index, reason: 'folder', title: mine.get(k) });
    else if (twice) duplicates.push({ index, reason: 'selection' });
    else if (elsewhere.has(k)) duplicates.push({ index, reason: 'other', folder: elsewhere.get(k) });
  });
  return json({ duplicates });
}

async function uploadPart(request, env) {
  const u = new URL(request.url);
  const key = u.searchParams.get('key');
  const uploadId = u.searchParams.get('uploadId');
  const n = Number(u.searchParams.get('n'));
  if (!allowedKey(key) || !uploadId || !Number.isInteger(n) || n < 1 || n > 10000) return fail('Invalid part');
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return fail('Empty part');
  const part = await env.MEDIA.resumeMultipartUpload(key, uploadId).uploadPart(n, body);
  return json({ partNumber: part.partNumber, etag: part.etag });
}

async function uploadComplete(request, env) {
  const b = await request.json().catch(() => null);
  if (!b || !allowedKey(b.key) || !b.uploadId || !Array.isArray(b.parts) || b.parts.length === 0) {
    return fail('Invalid request');
  }
  const sp = await getSpeaker(env, String(b.speaker_id || ''));
  if (!sp) return fail('Folder not found', 404);
  if (!b.key.startsWith(`${sp.category}/${sp.id}/`)) return fail('File does not belong to this folder');

  const title = cleanTitle(String(b.title || '').trim() || b.key.split('/').pop(), sp.name);
  if (title.length > 200) return fail('Title is too long (max 200 characters)');
  const dupe = await existingTitle(env, sp, title);
  if (dupe) {
    try {
      await env.MEDIA.resumeMultipartUpload(b.key, b.uploadId).abort();
    } catch (e) {
      /* already gone */
    }
    return fail(`Already uploaded: "${dupe}" is in ${sp.name}'s folder`, 409);
  }
  const parts = b.parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) }));

  await env.MEDIA.resumeMultipartUpload(b.key, b.uploadId).complete(parts);

  const duration = Math.max(0, Math.min(86400, Math.round(Number(b.duration_sec) || 0)));
  const id = `${sp.category}-${sp.id}-${rand(8)}`;
  await env.DB.prepare(
    `INSERT INTO items (id, speaker_id, category, title, audio_key, image_key, duration_sec, published_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, datetime('now'))`
  )
    .bind(id, sp.id, sp.category, title, b.key, duration)
    .run();
  return json({ id });
}

async function uploadAbort(request, env) {
  const b = await request.json().catch(() => null);
  if (b && allowedKey(b.key) && b.uploadId) {
    try {
      await env.MEDIA.resumeMultipartUpload(b.key, b.uploadId).abort();
    } catch (e) {
      /* already gone */
    }
  }
  return json({ ok: true });
}

// ---- router ----------------------------------------------------------------
export async function handleAdmin(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  if (!secretOf(env) || !env.MEDIA) {
    const msg = !secretOf(env)
      ? 'Admin is not set up: the AUTH_SECRET (or ADMIN_PASSWORD) secret is missing on the deployed Worker.'
      : 'Admin is not set up: the R2 bucket connection called MEDIA is missing on the deployed Worker.';
    if (path.startsWith('/admin/api/')) return fail(msg, 503);
    return new Response(msg, { status: 503 });
  }

  if (path === '/admin' && method === 'GET') {
    return new Response(ADMIN_HTML, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex',
      },
    });
  }

  if (path === '/admin/api/login' && method === 'POST') {
    if (!env.ADMIN_PASSWORD) return fail('Password sign-in is not set up (missing ADMIN_PASSWORD)', 503);
    const b = await request.json().catch(() => null);
    const given = String((b && b.password) || '');
    const ok = safeEqual(await hmac('cmp', given), await hmac('cmp', env.ADMIN_PASSWORD));
    if (!ok) {
      await new Promise((r) => setTimeout(r, 800)); // slow down guessing
      return fail('Wrong password', 401);
    }
    return json({ token: await signToken(env, 'web', WEB_TOKEN_TTL_MS) });
  }

  if (!path.startsWith('/admin/api/')) return fail('Not found', 404);
  const subject = await verifyToken(env, bearer(request));
  if (!subject) return fail('Not signed in', 401);
  if ((await isAdminSubject(env, subject)) !== 'admin') return fail('Admin access only', 403);

  const p = path.slice('/admin/api'.length);
  try {
    await ensureSchema(env);
    if (p === '/stats' && method === 'GET') return await stats(env);
    if (p === '/live-channels' && method === 'GET') return json(await listChannels(env));
    if (p === '/live-channels' && method === 'POST') {
      const b = await request.json().catch(() => null);
      const r = await saveChannel(env, b);
      return r.error ? fail(r.error) : json({ id: r.id, name: r.name, url: r.url });
    }
    const lm = p.match(/^\/live-channels\/([^/]+)$/);
    if (lm && method === 'DELETE') {
      await deleteChannel(env, decodeURIComponent(lm[1]));
      return json({ ok: true });
    }
    if (p === '/notices' && method === 'GET') return json(await allNotices(env));
    if (p === '/notices' && method === 'POST') {
      const b = await request.json().catch(() => null);
      const r = await saveNotice(env, b);
      if (r.error) return fail(r.error);
      let push = null;
      if (r.created && b && b.notify) push = await sendToTopic(env, 'notices', r.title, r.body || 'Tap to open The Message', { type: 'notice' });
      return json({ ...r, push });
    }
    const nm = p.match(/^\/notices\/([^/]+)$/);
    if (nm && method === 'DELETE') {
      await deleteNotice(env, decodeURIComponent(nm[1]));
      return json({ ok: true });
    }
    if (p === '/announce-new' && method === 'POST') return await announceNew(request, env);
    if (p === '/push-test' && method === 'POST') {
      if (!pushReady(env)) return fail('Push is not set up yet: the FCM_SERVICE_ACCOUNT secret is missing on the Worker.', 503);
      const r = await sendToTopic(env, 'live', 'Test alert', 'Push notifications are working.', { type: 'test' });
      return r.ok ? json({ ok: true }) : fail(r.error, 502);
    }
    if (p === '/users' && method === 'GET') return json(await adminListUsers(env));
    const um = p.match(/^\/users\/([^/]+)\/reset$/);
    if (um && method === 'POST') return await resetUser(env, decodeURIComponent(um[1]));

    if (p === '/speakers' && method === 'GET') return await listSpeakers(env, url.searchParams.get('category') || 'mog');
    if (p === '/speakers' && method === 'POST') return await saveSpeaker(request, env);

    if (p === '/speakers/reorder' && method === 'POST') return await reorderSpeakers(request, env);

    let m = p.match(/^\/speakers\/([^/]+)$/);
    if (m && method === 'DELETE') return await deleteSpeaker(env, decodeURIComponent(m[1]));

    m = p.match(/^\/speakers\/([^/]+)\/photo$/);
    if (m && method === 'PUT') return await uploadPhoto(request, env, decodeURIComponent(m[1]));

    m = p.match(/^\/speakers\/([^/]+)\/items$/);
    if (m && method === 'GET') return await listItems(env, decodeURIComponent(m[1]));

    m = p.match(/^\/items\/([^/]+)$/);
    if (m && method === 'PATCH') return await renameItem(request, env, decodeURIComponent(m[1]));
    if (m && method === 'DELETE') return await deleteItem(env, decodeURIComponent(m[1]));

    if (p === '/upload/start' && method === 'POST') return await uploadStart(request, env);
    if (p === '/upload/check' && method === 'POST') return await uploadCheck(request, env);
    if (p === '/upload/part' && method === 'PUT') return await uploadPart(request, env);
    if (p === '/upload/complete' && method === 'POST') return await uploadComplete(request, env);
    if (p === '/upload/abort' && method === 'POST') return await uploadAbort(request, env);

    return fail('Not found', 404);
  } catch (e) {
    return fail('Server error: ' + (e && e.message ? e.message : 'unknown'), 500);
  }
}
