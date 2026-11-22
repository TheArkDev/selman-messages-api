// Accounts and roles for The Message.
//
//   POST /api/auth/register  { name, email, password }  -> { token, user }
//   POST /api/auth/login     { email, password }        -> { token, user }
//   GET  /api/auth/me        (Bearer token)             -> { user }
//   POST /api/auth/change-password { current, password } (Bearer token)
//   GET/PUT /api/auth/sync   (Bearer token) -> the listener's favourites, playlists and history
//   POST /api/auth/delete    { password } (Bearer token) -> deletes the account
//   POST /api/auth/forgot    { email }                  -> emails a 6-digit code (if mail is set up)
//   POST /api/auth/reset     { email, code, password }  -> { token, user }
//
// Password reset by email needs two settings: RESEND_API_KEY (secret) and
// MAIL_FROM (e.g. "The Message <no-reply@yourdomain.com>"). Without them,
// an admin can reset a password from the app (admin -> Manage -> Users).
//
// Anyone can register and gets role "user". An account is an admin when its
// email is listed in the ADMIN_EMAILS setting (comma separated). The role is
// worked out fresh every time, so removing an email removes admin access.

const enc = new TextEncoder();
const APP_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const PBKDF2_ITERATIONS = 100000; // the most Workers allow

// ---- shared helpers (also used by admin.js) ---------------------------------
export function secretOf(env) {
  return env.AUTH_SECRET || env.ADMIN_PASSWORD || '';
}

export async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return toHex(new Uint8Array(sig));
}

export function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function b64urlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  return atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

// Token = base64url(payload) + "." + HMAC(payload). Payload: s=subject, e=expiry.
export async function signToken(env, subject, ttlMs) {
  const payload = b64urlEncode(JSON.stringify({ s: subject, e: Date.now() + ttlMs }));
  return `${payload}.${await hmac(secretOf(env), 'tok:' + payload)}`;
}

// Returns the subject ("web" for the password page, otherwise a user id) or null.
export async function verifyToken(env, token) {
  if (!secretOf(env) || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  if (!safeEqual(sig, await hmac(secretOf(env), 'tok:' + payload))) return null;
  try {
    const data = JSON.parse(b64urlDecode(payload));
    if (!data || typeof data.s !== 'string' || !(data.e > Date.now())) return null;
    return data.s;
  } catch (e) {
    return null;
  }
}

export function bearer(request) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function adminEmails(env) {
  return String(env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function roleFor(env, email) {
  return adminEmails(env).includes(String(email).toLowerCase()) ? 'admin' : 'user';
}

// ---- database ------------------------------------------------------------------
let usersReady = false;
async function ensureUsers(env) {
  if (usersReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS users (
       id         TEXT PRIMARY KEY,
       email      TEXT NOT NULL UNIQUE,
       name       TEXT NOT NULL,
       salt       TEXT NOT NULL,
       pass_hash  TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  ).run();
  usersReady = true;
}

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return toHex(new Uint8Array(bits));
}

function randomHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b);
}

function publicUser(env, u) {
  return { id: u.id, name: u.name, email: u.email, role: roleFor(env, u.email) };
}

// Used by admin.js: is this token subject allowed to use the admin API?
export async function isAdminSubject(env, subject) {
  if (subject === 'web') return 'admin';
  await ensureUsers(env);
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(subject).first();
  if (!u) return 'none';
  return roleFor(env, u.email) === 'admin' ? 'admin' : 'user';
}

// ---- handlers ------------------------------------------------------------------
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
const fail = (msg, status = 400) => json({ error: msg }, status);

async function register(request, env) {
  const b = await request.json().catch(() => null);
  if (!b) return fail('Invalid request');
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!name || name.length > 60) return fail('Please enter your name');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 120) return fail('Please enter a valid email');
  if (password.length < 8) return fail('Password must be at least 8 characters');
  if (password.length > 200) return fail('Password is too long');

  await ensureUsers(env);
  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (exists) return fail('An account with this email already exists', 409);

  const id = randomHex(12);
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  await env.DB.prepare('INSERT INTO users (id, email, name, salt, pass_hash) VALUES (?, ?, ?, ?, ?)')
    .bind(id, email, name, salt, hash)
    .run();
  const user = { id, name, email };
  return json({ token: await signToken(env, id, APP_TOKEN_TTL_MS), user: publicUser(env, user) });
}

async function login(request, env) {
  const b = await request.json().catch(() => null);
  if (!b) return fail('Invalid request');
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  await ensureUsers(env);
  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();

  // Always do the hashing work so a wrong email is not faster than a wrong password.
  const hash = await hashPassword(password.slice(0, 200), u ? u.salt : '00'.repeat(16));
  if (!u || !safeEqual(hash, u.pass_hash)) {
    await new Promise((r) => setTimeout(r, 600));
    return fail('Wrong email or password', 401);
  }
  return json({ token: await signToken(env, u.id, APP_TOKEN_TTL_MS), user: publicUser(env, u) });
}

async function me(request, env) {
  const subject = await verifyToken(env, bearer(request));
  if (!subject || subject === 'web') return fail('Not signed in', 401);
  await ensureUsers(env);
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(subject).first();
  if (!u) return fail('Not signed in', 401);
  return json({ user: publicUser(env, u) });
}


// ---- password change / reset ---------------------------------------------------
async function setPassword(env, userId, password) {
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  await env.DB.prepare('UPDATE users SET salt = ?, pass_hash = ? WHERE id = ?').bind(salt, hash, userId).run();
}

function checkNewPassword(password) {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 200) return 'Password is too long';
  return null;
}

async function changePassword(request, env) {
  const subject = await verifyToken(env, bearer(request));
  if (!subject || subject === 'web') return fail('Not signed in', 401);
  const b = await request.json().catch(() => null);
  if (!b) return fail('Invalid request');
  await ensureUsers(env);
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(subject).first();
  if (!u) return fail('Not signed in', 401);
  const current = String(b.current || '');
  const next = String(b.password || '');
  const hash = await hashPassword(current.slice(0, 200), u.salt);
  if (!safeEqual(hash, u.pass_hash)) {
    await new Promise((r) => setTimeout(r, 600));
    return fail('Your current password is wrong', 401);
  }
  const bad = checkNewPassword(next);
  if (bad) return fail(bad);
  await setPassword(env, u.id, next);
  return json({ ok: true });
}

// ---- sync favourites / playlists / history across phones ----------------------
const MAX_SYNC_BYTES = 900000;
let userDataReady = false;
async function ensureUserData(env) {
  if (userDataReady) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS user_data (user_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)'
  ).run();
  userDataReady = true;
}

async function syncUser(request, env) {
  const subject = await verifyToken(env, bearer(request));
  if (!subject || subject === 'web') return null;
  await ensureUsers(env);
  const u = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(subject).first();
  return u ? u.id : null;
}

async function getSync(request, env) {
  const id = await syncUser(request, env);
  if (!id) return fail('Not signed in', 401);
  await ensureUserData(env);
  const row = await env.DB.prepare('SELECT data, updated_at FROM user_data WHERE user_id = ?').bind(id).first();
  let data = null;
  try {
    data = row ? JSON.parse(row.data) : null;
  } catch (_) {}
  return json({ data, updated_at: row ? row.updated_at : 0 });
}

async function putSync(request, env) {
  const id = await syncUser(request, env);
  if (!id) return fail('Not signed in', 401);
  const text = await request.text();
  if (text.length > MAX_SYNC_BYTES) return fail('Too much data to sync', 413);
  let b;
  try {
    b = JSON.parse(text);
  } catch (_) {
    return fail('Invalid request');
  }
  if (!b || typeof b.data !== 'object' || b.data === null || Array.isArray(b.data)) return fail('Invalid request');
  await ensureUserData(env);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO user_data (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
  )
    .bind(id, JSON.stringify(b.data), now)
    .run();
  return json({ ok: true, updated_at: now });
}

// ---- delete account (required by Google Play for apps with sign-up) -------------
async function deleteAccount(request, env) {
  const subject = await verifyToken(env, bearer(request));
  if (!subject || subject === 'web') return fail('Not signed in', 401);
  const b = await request.json().catch(() => null);
  if (!b) return fail('Invalid request');
  await ensureUsers(env);
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(subject).first();
  if (!u) return fail('Not signed in', 401);
  const hash = await hashPassword(String(b.password || '').slice(0, 200), u.salt);
  if (!safeEqual(hash, u.pass_hash)) {
    await new Promise((r) => setTimeout(r, 600));
    return fail('Your password is wrong', 401);
  }
  await ensureResets(env);
  await env.DB.prepare('DELETE FROM password_resets WHERE email = ?').bind(u.email).run();
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(u.id).run();
  await ensureUserData(env);
  await env.DB.prepare('DELETE FROM user_data WHERE user_id = ?').bind(u.id).run();
  return json({ ok: true });
}

let resetsReady = false;
async function ensureResets(env) {
  if (resetsReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS password_resets (
       email      TEXT PRIMARY KEY,
       code_hash  TEXT NOT NULL,
       expires_at INTEGER NOT NULL,
       created_at INTEGER NOT NULL,
       attempts   INTEGER NOT NULL DEFAULT 0
     )`
  ).run();
  resetsReady = true;
}

const mailReady = (env) => !!(env.RESEND_API_KEY && env.MAIL_FROM);
const RESET_TTL_MS = 15 * 60 * 1000;
const RESET_RESEND_GAP_MS = 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;

async function codeHash(env, email, code) {
  return hmac(secretOf(env), `reset|${email}|${code}`);
}

async function forgot(request, env) {
  const b = await request.json().catch(() => null);
  const email = String((b && b.email) || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Please enter a valid email');

  // Mail not set up: tell the app so it can show the "ask an admin" message.
  if (!mailReady(env)) return json({ ok: true, email_enabled: false });

  await ensureUsers(env);
  await ensureResets(env);
  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  const old = await env.DB.prepare('SELECT created_at FROM password_resets WHERE email = ?').bind(email).first();
  const tooSoon = old && Date.now() - old.created_at < RESET_RESEND_GAP_MS;

  // The reply is the same whether or not the account exists.
  if (u && !tooSoon) {
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    const code = String(bytes[0] % 1000000).padStart(6, '0');
    await env.DB.prepare(
      `INSERT INTO password_resets (email, code_hash, expires_at, created_at, attempts)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
         created_at = excluded.created_at, attempts = 0`
    )
      .bind(email, await codeHash(env, email, code), Date.now() + RESET_TTL_MS, Date.now())
      .run();
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: env.MAIL_FROM,
          to: [email],
          subject: 'Your The Message reset code',
          text:
            `Hello ${u.name},\n\nYour code to reset your The Message password is ${code}.\n` +
            `It works for 15 minutes. If you did not ask for this, you can ignore this email.`,
        }),
      });
    } catch (e) {
      /* the person can ask for another code */
    }
  }
  return json({ ok: true, email_enabled: true });
}

async function reset(request, env) {
  const b = await request.json().catch(() => null);
  if (!b) return fail('Invalid request');
  const email = String(b.email || '').trim().toLowerCase();
  const code = String(b.code || '').trim();
  const password = String(b.password || '');
  const bad = checkNewPassword(password);
  if (bad) return fail(bad);
  const wrong = () => fail('That code is wrong or has expired', 400);
  if (!/^\d{6}$/.test(code)) return wrong();

  await ensureUsers(env);
  await ensureResets(env);
  const row = await env.DB.prepare('SELECT * FROM password_resets WHERE email = ?').bind(email).first();
  if (!row || row.expires_at < Date.now() || row.attempts >= RESET_MAX_ATTEMPTS) return wrong();

  const given = await codeHash(env, email, code);
  if (!safeEqual(given, row.code_hash)) {
    await env.DB.prepare('UPDATE password_resets SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
    return wrong();
  }
  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!u) return wrong();
  await setPassword(env, u.id, password);
  await env.DB.prepare('DELETE FROM password_resets WHERE email = ?').bind(email).run();
  return json({ token: await signToken(env, u.id, APP_TOKEN_TTL_MS), user: publicUser(env, u) });
}

// ---- used by admin.js ------------------------------------------------------------
export async function adminListUsers(env) {
  await ensureUsers(env);
  const { results } = await env.DB.prepare(
    'SELECT id, name, email, created_at FROM users ORDER BY created_at DESC, name'
  ).all();
  return results.map((u) => ({ ...u, role: roleFor(env, u.email) }));
}

const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Gives the account a new random password and returns it (to show the admin once).
export async function adminResetPassword(env, userId) {
  await ensureUsers(env);
  const u = await env.DB.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(userId).first();
  if (!u) return null;
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const password = [...bytes].map((x) => TEMP_ALPHABET[x % TEMP_ALPHABET.length]).join('');
  await setPassword(env, u.id, password);
  return { password, name: u.name, email: u.email };
}

export async function adminUserCount(env) {
  await ensureUsers(env);
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  return r ? r.n : 0;
}

export async function handleAuth(request, env) {
  if (!secretOf(env)) return fail('Accounts are not set up yet (missing AUTH_SECRET)', 503);
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  try {
    if (path === '/api/auth/register' && request.method === 'POST') return await register(request, env);
    if (path === '/api/auth/login' && request.method === 'POST') return await login(request, env);
    if (path === '/api/auth/me' && request.method === 'GET') return await me(request, env);
    if (path === '/api/auth/change-password' && request.method === 'POST') return await changePassword(request, env);
    if (path === '/api/auth/sync' && request.method === 'GET') return await getSync(request, env);
    if (path === '/api/auth/sync' && request.method === 'PUT') return await putSync(request, env);
    if (path === '/api/auth/delete' && request.method === 'POST') return await deleteAccount(request, env);
    if (path === '/api/auth/forgot' && request.method === 'POST') return await forgot(request, env);
    if (path === '/api/auth/reset' && request.method === 'POST') return await reset(request, env);
    return fail('Not found', 404);
  } catch (e) {
    return fail('Server error', 500);
  }
}
