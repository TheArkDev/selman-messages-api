// Run with: node --no-warnings test/live-alerts.test.mjs   (Node 22+, uses the built-in SQLite)
// Checks that a live stream sends ONE alert, even when YouTube flickers or two checks overlap.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';

const root = process.argv[2] || new URL('..', import.meta.url).pathname.replace(/\/$/, ''); // folder with src/ and schema.sql
const label = process.argv[3] || 'live alerts';
const { runLiveAlerts } = await import(root + '/src/alerts.js');
const { saveChannel } = await import(root + '/src/live.js');

// ---- D1-like wrapper around real SQLite
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(root + '/schema.sql', 'utf8'));
const wrap = (sql, args = []) => {
  const st = () => sqlite.prepare(sql);
  return {
    all: async () => ({ results: st().all(...args) }),
    first: async () => st().get(...args) ?? null,
    run: async () => { const r = st().run(...args); return { meta: { changes: Number(r.changes) } }; },
  };
};
const DB = { prepare: (sql) => ({ ...wrap(sql), bind: (...a) => wrap(sql, a) }) };

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = {
  DB,
  FCM_SERVICE_ACCOUNT: JSON.stringify({
    project_id: 'p', client_email: 'a@b.c',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }),
};

// ---- fake YouTube + Firebase
let youtube = 'live';      // 'live' | 'flicker'
let videoId = 'AAAAAAAAAAA';
let fcmFails = false;
let alerts = 0;
const page = (body) => new Response(`<html>ytInitialData ${body}</html>`, { status: 200 });
const fetchFn = async (url, opts) => {
  url = String(url);
  if (url.includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
  if (url.includes('fcm.googleapis.com')) {
    if (fcmFails) return new Response('boom', { status: 500 });
    alerts++; return new Response('{}', { status: 200 });
  }
  if (url.includes('/watch?v=')) return page('"videoDetails" {}');                       // flicker: watch page says not live
  if (url.endsWith('/live')) {
    return youtube === 'live'
      ? page(`<link rel="canonical" href="https://www.youtube.com/watch?v=${videoId}"><meta property="og:title" content="Sunday Service">"isLive":true`)
      : page('nothing live here');
  }
  return new Response('', { status: 404 });
};

const { ensureSchema } = await import(root + '/src/schema.js');
await ensureSchema(env);
await env.DB.prepare('INSERT INTO live_channels (id,name,url,sort) VALUES (?,?,?,?)').bind('c1', 'Church', 'https://www.youtube.com/@church', 1).run();
const fresh = () => saveChannel(env, { id: 'c1', name: 'Church', url: 'https://www.youtube.com/@church' }); // clears the 45s page cache
let t = Date.UTC(2026, 10, 27, 9, 0, 0);
const run = async (advanceMin = 2) => { t += advanceMin * 60000; await fresh(); return runLiveAlerts(env, fetchFn, t); };
const results = [];
const check = (name, got, want) => results.push([got === want ? 'PASS' : 'FAIL', name, `alerts=${got} (expected ${want})`]);

// 1. Service goes live and stays live for 10 checks -> exactly one alert
for (let i = 0; i < 10; i++) await run();
check('live for 20 min: one alert only', alerts, 1);

// 2. YouTube flickers "not live" then answers live again, same video (the reported bug)
for (let i = 0; i < 4; i++) { youtube = 'flicker'; await run(); youtube = 'live'; await run(); }
check('flickering 4 times on the same stream: no repeats', alerts, 1);

// 3. Overlapping checks (two runs at the same moment) for a NEW stream
youtube = 'live'; videoId = 'BBBBBBBBBBB'; t += 30 * 60000; await fresh();
await Promise.all([runLiveAlerts(env, fetchFn, t), runLiveAlerts(env, fetchFn, t)]);
check('new stream + two overlapping checks: exactly one more', alerts, 2);

// 4. Another new stream within the cooldown is held back...
videoId = 'CCCCCCCCCCC'; await run(2);
check('different video 2 min later: held back by cooldown', alerts, 2);
// ...but is not lost: it alerts once the cooldown has passed
await run(25);
check('same video after cooldown: alerts once', alerts, 3);

// 5. Firebase fails once: nothing lost, retried next check, not duplicated
videoId = 'DDDDDDDDDDD'; fcmFails = true; await run(30);
check('Firebase down: no alert sent', alerts, 3);
fcmFails = false; await run(2); await run(2);
check('Firebase back: sent once, not repeated', alerts, 4);

// 6. Stream ends, hours pass, same id live again -> allowed again
youtube = 'flicker'; await run(7 * 60); youtube = 'live'; await run(2);
check('same id after 7h off: alerts again', alerts, 5);

console.log(`\n=== ${label} ===`);
for (const r of results) console.log(r.join('  '));
