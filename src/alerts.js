// Called by the Worker's schedule (every 2 minutes): for every channel that is
// live, send ONE "live now" alert per stream.
//
// Why a stream could alert more than once before, and what stops it now:
//  * YouTube's page sometimes answers "not live" for a moment while the stream is
//    still running. The old code forgot the stream on that one answer, so the very
//    next check looked like a brand-new stream. Now the video id is remembered and
//    the same id is never announced again, however often the answer flickers.
//    (A new stream always has a new video id, so new streams still alert.)
//  * Two checks overlapping each other could both send. The alert is now claimed
//    in the database first, in one step, and only the check that wins sends it.
//  * A channel can alert at most once every COOLDOWN_MS, which also caps the damage
//    if YouTube flips between two different videos.
//  * The remembered id is only cleared after the channel has been off for
//    REARM_MS, so a stream id that is genuinely reused much later can alert again.

import { liveAll } from './live.js';
import { ensureSchema } from './schema.js';
import { sendToTopic, pushReady } from './push.js';

const COOLDOWN_MS = 20 * 60 * 1000;
const REARM_MS = 6 * 60 * 60 * 1000;

export async function runLiveAlerts(env, fetchFn = fetch, now = Date.now()) {
  if (!pushReady(env)) return { sent: 0 };
  await ensureSchema(env);
  const { channels } = await liveAll(env, fetchFn);
  const { results } = await env.DB.prepare(
    'SELECT channel_id, video_id, alerted_at, last_live_at FROM live_state'
  ).all();
  const known = new Map((results || []).map((r) => [r.channel_id, r]));
  let sent = 0;

  for (const c of channels) {
    if (c.error) continue; // can't tell; don't alert and don't change anything
    const row = known.get(c.id);

    if (!(c.live && c.video_id)) {
      // Not live. Do NOT forget the stream yet: only after a long time off.
      if (row && row.video_id && now - (row.last_live_at || row.alerted_at || 0) > REARM_MS) {
        await env.DB.prepare('UPDATE live_state SET video_id = NULL WHERE channel_id = ?').bind(c.id).run();
      }
      continue;
    }

    // Live. Note that we saw it (used for the re-arm timer above).
    if (row) {
      await env.DB.prepare('UPDATE live_state SET last_live_at = ? WHERE channel_id = ?').bind(now, c.id).run();
    }

    if (row && row.video_id === c.video_id) continue; // already alerted for this stream
    if (row && row.alerted_at && now - row.alerted_at < COOLDOWN_MS) continue; // too soon after the last alert

    // Claim it first. If another check already claimed this video, nothing changes
    // and we do not send.
    const claim = await env.DB.prepare(
      `INSERT INTO live_state (channel_id, video_id, alerted_at, last_live_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET video_id = excluded.video_id, alerted_at = excluded.alerted_at, last_live_at = excluded.last_live_at
       WHERE live_state.video_id IS NOT excluded.video_id`
    ).bind(c.id, c.video_id, now, now).run();
    if (!claim || !claim.meta || !claim.meta.changes) continue;

    const r = await sendToTopic(
      env,
      'live',
      `${c.name} is live now`,
      c.title || 'Join the service in the app',
      { type: 'live', channel_id: c.id },
      fetchFn
    );
    if (r.ok) {
      sent++;
    } else {
      // Nothing was sent: hand the claim back so the next check tries again.
      await env.DB.prepare('UPDATE live_state SET video_id = ?, alerted_at = ? WHERE channel_id = ?')
        .bind(row ? row.video_id : null, row ? row.alerted_at : null, c.id)
        .run();
    }
  }
  return { sent };
}
