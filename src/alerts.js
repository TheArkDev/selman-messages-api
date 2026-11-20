// Called by the Worker's schedule: for every channel that is live, send one
// "live now" alert (once per stream), then remember that we did.

import { liveAll } from './live.js';
import { ensureSchema } from './schema.js';
import { sendToTopic, pushReady } from './push.js';

export async function runLiveAlerts(env, fetchFn = fetch) {
  if (!pushReady(env)) return { sent: 0 };
  await ensureSchema(env);
  const { channels } = await liveAll(env, fetchFn);
  const { results } = await env.DB.prepare('SELECT channel_id, video_id FROM live_state').all();
  const known = new Map((results || []).map((r) => [r.channel_id, r.video_id]));
  let sent = 0;

  for (const c of channels) {
    if (c.error) continue; // can't tell; don't alert and don't reset
    if (c.live && c.video_id) {
      if (known.get(c.id) === c.video_id) continue; // already alerted for this stream
      const r = await sendToTopic(env, 'live', `${c.name} is live now`, c.title || 'Join the service in the app', {
        type: 'live',
        channel_id: c.id,
      }, fetchFn);
      if (r.ok) {
        await env.DB.prepare(
          'INSERT INTO live_state (channel_id, video_id) VALUES (?, ?) ON CONFLICT(channel_id) DO UPDATE SET video_id = excluded.video_id'
        ).bind(c.id, c.video_id).run();
        sent++;
      }
    } else if (known.has(c.id) && known.get(c.id)) {
      // Stream ended: forget it so the next stream alerts again.
      await env.DB.prepare('UPDATE live_state SET video_id = NULL WHERE channel_id = ?').bind(c.id).run();
    }
  }
  return { sent };
}
