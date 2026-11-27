# selman-messages-api
## Changes in this version

- `PATCH /admin/api/items/:id` accepts `speaker_id` to move an item to another
  folder. Only the database row changes (the audio keeps its R2 key and the item
  keeps its id, so favourites and downloads keep working). Refused with 409 if
  the same title is already in the target folder.
- `POST /admin/api/upload/check` takes `{ speaker_id, filenames }` and reports
  duplicates before anything uploads (same folder, twice in the batch, or the
  same title in another folder).
- `GET /api/home`: "Suggested for you" is now mixed across MOG, Selman, Songs and
  Prayer (one from each folder in turn) instead of MOG only. Today's Messages is
  unchanged. No database changes are needed.

- `GET /api/home` also returns `latest`: the 10 newest uploads across every
  folder (the app shows 5 as "Recently added"). Home is cached for 2 minutes.
- `POST /admin/api/announce-new` sends ONE push alert (topic `new`) for a batch
  of uploads. The app calls it once per folder when a batch finishes, only if the
  admin turned on "Notify listeners". Needs the existing `FCM_SERVICE_ACCOUNT`
  secret, the same one live alerts use.
- Listens are also counted per day in a new `play_daily` table (created
  automatically). `GET /admin/api/stats` now returns `daily` (last 14 days),
  `trending` (this week), `by_category`, `top_folders`, `never_played` and
  `new_users_7d`. Daily history starts from the day this is deployed.

- **Live alerts no longer repeat.** YouTube's page sometimes says "not live" for a
  moment while a stream is still running. The Worker used to forget the stream on
  that one answer, so the next check looked like a new stream and alerted again.
  Now it remembers the video id and never announces the same one twice, claims
  the alert in the database before sending (so overlapping checks cannot both
  send), waits at least 20 minutes between alerts for one channel, and only
  re-arms a channel after it has been off for 6 hours. If Firebase is down the
  claim is handed back, so the alert is retried rather than lost. Two columns
  (`alerted_at`, `last_live_at`) are added to `live_state` automatically.
  Test: `node --no-warnings test/live-alerts.test.mjs`.

Deploy with `npx wrangler deploy`.
