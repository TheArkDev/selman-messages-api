// Adds the newer columns to an existing database the first time the Worker
// needs them, so no manual SQL has to be run in the D1 console.
let ready = null;

const NEW_COLUMNS = [
  ['preached_on', 'TEXT'], // date the message was preached, YYYY-MM-DD
  ['series', 'TEXT'], // e.g. a conference or teaching series
  ['description', 'TEXT'],
  ['plays', 'INTEGER NOT NULL DEFAULT 0'],
];

export function ensureSchema(env) {
  if (!ready) {
    ready = (async () => {
      const info = await env.DB.prepare('PRAGMA table_info(items)').all();
      const have = new Set((info.results || []).map((r) => r.name));
      for (const [name, def] of NEW_COLUMNS) {
        if (!have.has(name)) await env.DB.prepare(`ALTER TABLE items ADD COLUMN ${name} ${def}`).run();
      }
      // Short biography shown at the top of a speaker's folder.
      const sp = await env.DB.prepare('PRAGMA table_info(speakers)').all();
      if (!(sp.results || []).some((r) => r.name === 'bio')) {
        await env.DB.prepare('ALTER TABLE speakers ADD COLUMN bio TEXT').run();
      }
      // Each signed-in listener's favourites / playlists / history, so they follow them to a new phone.
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS user_data (user_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)'
      ).run();
      // Announcements shown on Home.
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, event_date TEXT, expires_on TEXT, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')))'
      ).run();
      // Which live stream we already sent an alert for, so each stream alerts only once.
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS live_state (channel_id TEXT PRIMARY KEY, video_id TEXT)'
      ).run();
      // Last time each channel was seen live (keeps one bad YouTube answer from switching it off).
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS live_seen (channel_id TEXT PRIMARY KEY, video_id TEXT, title TEXT, seen_at INTEGER)'
      ).run();
      // The ministries whose YouTube channels the Live tab follows.
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS live_channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 100)'
      ).run();
    })().catch((e) => {
      ready = null; // try again on the next request
      throw e;
    });
  }
  return ready;
}
