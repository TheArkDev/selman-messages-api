// Push notifications through Firebase Cloud Messaging (HTTP v1).
//
// Needs one secret on the Worker: FCM_SERVICE_ACCOUNT = the whole JSON file of a
// Firebase service account. Without it, push quietly does nothing.

const enc = new TextEncoder();

export const pushReady = (env) => !!env.FCM_SERVICE_ACCOUNT;

function b64url(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

let tokenCache = null; // { token, exp }

async function accessToken(env, fetchFn) {
  if (tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.token;
  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64url(
    enc.encode(
      JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      })
    )
  );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(head + '.' + claim));
  const jwt = head + '.' + claim + '.' + b64url(sig);

  const res = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error('Google sign-in failed: ' + (data.error_description || res.status));
  tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

/**
 * Sends a notification to everyone subscribed to a topic ("live" or "notices").
 * Returns { ok: true } or { ok: false, error }. Never throws.
 */
export async function sendToTopic(env, topic, title, body, data = {}, fetchFn = fetch) {
  if (!pushReady(env)) return { ok: false, error: 'Push is not set up (FCM_SERVICE_ACCOUNT is missing)' };
  try {
    const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT);
    const token = await accessToken(env, fetchFn);
    const res = await fetchFn(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          topic,
          notification: { title, body },
          data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
          android: { priority: 'HIGH', notification: { channel_id: 'live_alerts', color: '#D4AF37' } },
        },
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: `FCM ${res.status}: ${t.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
