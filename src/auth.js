// Accounts and roles for Selman Messages.
//
//   POST /api/auth/register  { name, email, password }  -> { token, user }
//   POST /api/auth/login     { email, password }        -> { token, user }
//   GET  /api/auth/me        (Bearer token)             -> { user }
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

export async function handleAuth(request, env) {
  if (!secretOf(env)) return fail('Accounts are not set up yet (missing AUTH_SECRET)', 503);
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  try {
    if (path === '/api/auth/register' && request.method === 'POST') return await register(request, env);
    if (path === '/api/auth/login' && request.method === 'POST') return await login(request, env);
    if (path === '/api/auth/me' && request.method === 'GET') return await me(request, env);
    return fail('Not found', 404);
  } catch (e) {
    return fail('Server error', 500);
  }
}
