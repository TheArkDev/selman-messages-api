// Announcements (conferences, special services...) shown on the Home tab.

function newId() {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return 'nt-' + [...b].map((x) => (x % 36).toString(36)).join('');
}

const dateOk = (d) => !d || /^\d{4}-\d{2}-\d{2}$/.test(d);

/** What listeners see: not expired yet, newest first. */
export async function activeNotices(env) {
  const today = new Date().toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT id, title, body, event_date, expires_on FROM notices
     WHERE expires_on IS NULL OR expires_on = '' OR expires_on >= ?
     ORDER BY created_at DESC, id LIMIT 10`
  )
    .bind(today)
    .all();
  return results || [];
}

export async function allNotices(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, title, body, event_date, expires_on FROM notices ORDER BY created_at DESC, id LIMIT 100'
  ).all();
  return results || [];
}

/** Adds or updates one. Returns the row or { error }. */
export async function saveNotice(env, b) {
  const title = String((b && b.title) || '').trim().slice(0, 120);
  if (!title) return { error: 'Please enter a title' };
  const body = String((b && b.body) || '').trim().slice(0, 1000);
  const eventDate = String((b && b.event_date) || '').trim();
  const expires = String((b && b.expires_on) || '').trim();
  if (!dateOk(eventDate) || !dateOk(expires)) return { error: 'Dates must look like 2026-12-31' };

  const id = b && b.id ? String(b.id) : '';
  if (id) {
    await env.DB.prepare('UPDATE notices SET title = ?, body = ?, event_date = ?, expires_on = ? WHERE id = ?')
      .bind(title, body, eventDate || null, expires || null, id)
      .run();
    return { id, title, body, event_date: eventDate || null, expires_on: expires || null };
  }
  const nid = newId();
  await env.DB.prepare('INSERT INTO notices (id, title, body, event_date, expires_on) VALUES (?, ?, ?, ?, ?)')
    .bind(nid, title, body, eventDate || null, expires || null)
    .run();
  return { id: nid, title, body, event_date: eventDate || null, expires_on: expires || null, created: true };
}

export async function deleteNotice(env, id) {
  await env.DB.prepare('DELETE FROM notices WHERE id = ?').bind(id).run();
}
