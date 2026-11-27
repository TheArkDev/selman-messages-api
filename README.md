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

Deploy with `npx wrangler deploy`.
