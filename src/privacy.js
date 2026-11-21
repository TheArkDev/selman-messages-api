// Public web pages Google Play asks for: a privacy policy and how to delete an account.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(title, body) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - The Message</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:0 auto;padding:24px 18px;color:#1d1d1d;background:#fffdf8}
h1{color:#6d0f26}h2{color:#6d0f26;margin-top:1.6em}a{color:#6d0f26}code{background:#f1e9d3;padding:1px 5px;border-radius:4px}</style></head>
<body>${body}</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' } }
  );
}

export function privacyPage(env) {
  const contact = env.CONTACT_EMAIL
    ? `<a href="mailto:${esc(env.CONTACT_EMAIL)}">${esc(env.CONTACT_EMAIL)}</a>`
    : 'the app administrator through the app';
  return page(
    'Privacy Policy',
    `<h1>Privacy Policy</h1>
<p>The Message is an app for listening to sermons, songs and prayers, and for watching live church services. This page explains what the app collects and why.</p>

<h2>What we collect</h2>
<ul>
<li><b>Account details</b> - when you create an account: your name, your email address and a password. Your password is stored only as a salted hash; nobody can read it.</li>
<li><b>Listening counts</b> - when you listen to a message for about 30 seconds, we add one to that message's play count. This count is not linked to your name.</li>
<li><b>Notifications</b> - if you allow notifications, Google Firebase Cloud Messaging gives your phone an anonymous token so we can send "live now" and announcement alerts. You can turn these off in the app's Profile page or in your phone settings.</li>
<li><b>Crash reports</b> - if the app crashes, Firebase Crashlytics receives technical details (device model, Android version, the error). It does not include your name or messages.</li>
</ul>

<h2>Favourites, playlists and history</h2>
<p>These are saved on your phone. If you are signed in, they are also saved with your account so they follow you to a new phone, and they are deleted when you delete your account. If you are not signed in, they stay only on your phone. Messages you download for offline listening are stored privately on your phone and are never sent to us.</p>

<h2>Live videos</h2>
<p>The Live tab plays videos with the YouTube player. YouTube (Google) may collect data according to <a href="https://policies.google.com/privacy">Google's privacy policy</a>.</p>

<h2>Sharing</h2>
<p>We do not sell your data or use it for advertising. Data is processed by the services that run the app: Cloudflare (hosting and database) and Google Firebase (notifications and crash reports).</p>

<h2>Deleting your account</h2>
<p>You can delete your account and its details at any time inside the app: <b>Profile &rarr; Delete my account</b>. If you cannot open the app, contact ${contact} and we will delete it for you. See <a href="/delete-account">how to delete your account</a>.</p>

<h2>Children</h2>
<p>The app is not directed at children under 13 and we do not knowingly collect their data.</p>

<h2>Contact</h2>
<p>Questions about this policy: ${contact}.</p>`
  );
}

export function deleteAccountPage(env) {
  const contact = env.CONTACT_EMAIL
    ? `<a href="mailto:${esc(env.CONTACT_EMAIL)}">${esc(env.CONTACT_EMAIL)}</a>`
    : 'the app administrator';
  return page(
    'Delete your account',
    `<h1>Delete your account</h1>
<ol>
<li>Open the Selman Messages app and sign in.</li>
<li>Go to the <b>Profile</b> tab.</li>
<li>Tap <b>Delete my account</b> and enter your password to confirm.</li>
</ol>
<p><b>What is deleted:</b> your name, email address, password hash and synced favourites, playlists and history are removed straight away. Copies kept on your phone (including downloads) are removed when you uninstall the app or clear its data.</p>
<p>If you cannot sign in, email ${contact} from the address you registered with and we will delete the account for you.</p>
<p><a href="/privacy">Read the privacy policy</a></p>`
  );
}
