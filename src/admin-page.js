// The admin web page, served by the Worker at /admin.
// NOTE: the script inside uses string concatenation only (no backticks or
// dollar-brace) because this whole file is one template literal.

export const ADMIN_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>The Message Admin</title>
<style>
  :root { --gold:#d4af37; --lgold:#f1d68a; --maroon:#6d0f26; --deep:#2a0610; --green:#1f7a45; --black:#0b0b0b; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, Segoe UI, Roboto, sans-serif; color:#fff;
         background: linear-gradient(180deg, var(--black), var(--deep) 60%, var(--black)); min-height:100vh; }
  header { padding:16px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid #d4af3744; }
  h1 { margin:0; font-size:20px; color:var(--gold); }
  main { max-width:900px; margin:0 auto; padding:16px; }
  .card { background:#ffffff0d; border:1px solid #d4af3755; border-radius:14px; padding:16px; margin-bottom:16px; }
  input[type=text], input[type=password], input[type=number] {
    width:100%; padding:10px 12px; border-radius:10px; border:1px solid #d4af3799; background:#0008; color:#fff; font-size:15px; }
  input[type=color] { width:48px; height:40px; border:none; background:none; padding:0; }
  button { background:var(--gold); color:#000; border:0; border-radius:10px; padding:10px 14px; font-weight:700; font-size:14px; cursor:pointer; }
  button.ghost { background:transparent; color:var(--gold); border:1px solid var(--gold); }
  button.danger { background:#b3261e; color:#fff; }
  button:disabled { opacity:.5; cursor:default; }
  .tabs { display:flex; gap:8px; margin-bottom:16px; }
  .tabs button { flex:1; background:transparent; color:#fff; border:1px solid #d4af3766; }
  .tabs button.on { background:var(--gold); color:#000; }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .grow { flex:1; min-width:140px; }
  .folders { display:grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap:12px; }
  .folder { border:2px solid; border-radius:14px; padding:10px; text-align:center; cursor:pointer; background:#0006; }
  .folder img, .folder .ph { width:84px; height:84px; border-radius:50%; object-fit:cover; display:block; margin:0 auto 8px; background:linear-gradient(135deg,var(--maroon),var(--green)); }
  .folder b { display:block; font-size:14px; }
  .folder small { color:var(--lgold); }
  .muted { color:#fff9; font-size:13px; }
  .err { color:#ff8a80; font-size:14px; min-height:18px; }
  .item { display:flex; gap:8px; align-items:center; padding:10px 0; border-bottom:1px solid #ffffff1a; }
  .item .t { flex:1; word-break:break-word; }
  .bar { height:6px; background:#ffffff22; border-radius:3px; overflow:hidden; margin-top:6px; }
  .bar i { display:block; height:100%; width:0; background:var(--gold); transition:width .2s; }
  .up { padding:10px 0; border-bottom:1px solid #ffffff1a; }
  .drop { border:2px dashed #d4af37aa; border-radius:14px; padding:22px; text-align:center; color:var(--lgold); cursor:pointer; }
  .drop.over { background:#d4af3722; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<header>
  <h1>The Message &middot; Admin</h1>
  <button class="ghost" id="logout" hidden>Sign out</button>
</header>
<main>
  <section id="login" class="card" style="max-width:380px;margin:40px auto">
    <h2 style="margin-top:0;color:var(--gold)">Sign in</h2>
    <p class="muted">Enter the admin password.</p>
    <input type="password" id="pw" placeholder="Password" autocomplete="current-password">
    <p class="err" id="loginErr"></p>
    <button id="loginBtn">Sign in</button>
  </section>

  <section id="app" hidden>
    <div class="tabs" id="tabs"></div>

    <div id="foldersView">
      <div class="card">
        <div class="row">
          <h3 style="margin:0;flex:1;color:var(--gold)" id="foldersTitle">Folders</h3>
          <button id="addFolderBtn">+ New folder</button>
        </div>
        <div id="addFolder" hidden style="margin-top:14px">
          <div class="row">
            <input type="text" id="newName" class="grow" placeholder="Name, e.g. Pastor Jane Doe" maxlength="80">
            <label class="muted">Glow <input type="color" id="newGlow" value="#ffc107"></label>
            <button id="saveFolder">Create</button>
          </div>
        </div>
        <p class="err" id="foldersErr"></p>
      </div>
      <div class="folders" id="folders"></div>
    </div>

    <div id="folderView" hidden>
      <div class="card">
        <div class="row">
          <button class="ghost" id="back">&larr; All folders</button>
          <h3 style="margin:0;flex:1;color:var(--gold)" id="fname"></h3>
        </div>
        <div class="row" style="margin-top:12px">
          <input type="text" id="editName" class="grow" maxlength="80">
          <label class="muted">Glow <input type="color" id="editGlow"></label>
          <button id="saveEdit">Save</button>
        </div>
        <div class="row" style="margin-top:12px">
          <span class="muted grow" id="photoState"></span>
          <button class="ghost" id="photoBtn">Change photo</button>
          <input type="file" id="photoFile" accept="image/jpeg,image/png,image/webp" hidden>
          <button class="danger" id="delFolder">Delete folder</button>
        </div>
        <p class="err" id="folderErr"></p>
      </div>

      <div class="card">
        <h3 style="margin-top:0;color:var(--gold)">Upload audio</h3>
        <div class="drop" id="drop">Tap to choose files, or drop them here<br><span class="muted">mp3, m4a, aac, wav, ogg &middot; large files are fine</span></div>
        <input type="file" id="audioFiles" accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.opus" multiple hidden>
        <div id="uploads"></div>
      </div>

      <div class="card">
        <h3 style="margin-top:0;color:var(--gold)" id="itemsTitle">Items</h3>
        <div id="items"></div>
      </div>
    </div>
  </section>
</main>

<script>
(function () {
  var API = '/admin/api';
  var CATS = [['mog', 'MOG'], ['songs', 'Songs'], ['prayer', 'Prayer']];
  var CHUNK = 8 * 1024 * 1024;
  var token = '';
  try { token = sessionStorage.getItem('adm') || ''; } catch (e) {}
  var cat = 'mog', folders = [], cur = null;

  function $(id) { return document.getElementById(id); }
  function enc(s) { return encodeURIComponent(s); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'text') n.textContent = props[k];
      else if (k === 'class') n.className = props[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), props[k]);
      else n.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  async function api(path, opt) {
    opt = opt || {};
    opt.headers = Object.assign({ authorization: 'Bearer ' + token }, opt.headers || {});
    var r = await fetch(API + path, opt);
    var j = await r.json().catch(function () { return {}; });
    if (r.status === 401 && path !== '/login') { signOut(); throw new Error('Please sign in again'); }
    if (!r.ok) throw new Error(j.error || ('Error ' + r.status));
    return j;
  }
  function post(path, body) {
    return api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  // ---- sign in / out ----
  function showApp(on) {
    $('login').hidden = on; $('app').hidden = !on; $('logout').hidden = !on;
  }
  function signOut() {
    token = ''; try { sessionStorage.removeItem('adm'); } catch (e) {}
    showApp(false);
  }
  async function signIn() {
    $('loginErr').textContent = ''; $('loginBtn').disabled = true;
    try {
      var r = await post('/login', { password: $('pw').value });
      token = r.token; try { sessionStorage.setItem('adm', token); } catch (e) {}
      $('pw').value = '';
      showApp(true); renderTabs(); loadFolders();
    } catch (e) { $('loginErr').textContent = e.message; }
    $('loginBtn').disabled = false;
  }
  $('loginBtn').onclick = signIn;
  $('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') signIn(); });
  $('logout').onclick = signOut;

  // ---- folders ----
  function renderTabs() {
    var t = $('tabs'); t.innerHTML = '';
    CATS.forEach(function (c) {
      t.appendChild(el('button', { text: c[1], class: c[0] === cat ? 'on' : '', onclick: function () {
        cat = c[0]; cur = null; renderTabs(); showFolderList(); loadFolders();
      } }));
    });
  }
  function showFolderList() { $('foldersView').hidden = false; $('folderView').hidden = true; }

  async function loadFolders() {
    $('foldersErr').textContent = '';
    try {
      folders = await api('/speakers?category=' + cat);
      var box = $('folders'); box.innerHTML = '';
      $('foldersTitle').textContent = (CATS.filter(function (c) { return c[0] === cat; })[0][1]) + ' folders';
      if (!folders.length) box.appendChild(el('p', { class: 'muted', text: 'No folders yet. Create the first one.' }));
      folders.forEach(function (f) {
        var pic = f.image_url ? el('img', { src: f.image_url, alt: '' }) : el('div', { class: 'ph' });
        var card = el('div', { class: 'folder', onclick: function () { openFolder(f.id); } }, [
          pic, el('b', { text: f.name }), el('small', { text: f.count + ' item' + (f.count === 1 ? '' : 's') })
        ]);
        card.style.borderColor = f.glow || '#ffc107';
        card.style.boxShadow = '0 0 14px ' + (f.glow || '#ffc107') + '88';
        box.appendChild(card);
      });
    } catch (e) { $('foldersErr').textContent = e.message; }
  }

  $('addFolderBtn').onclick = function () { $('addFolder').hidden = !$('addFolder').hidden; };
  $('saveFolder').onclick = async function () {
    $('foldersErr').textContent = '';
    try {
      await post('/speakers', { category: cat, name: $('newName').value, glow: $('newGlow').value });
      $('newName').value = ''; $('addFolder').hidden = true; loadFolders();
    } catch (e) { $('foldersErr').textContent = e.message; }
  };

  // ---- one folder ----
  async function openFolder(id) {
    cur = folders.filter(function (f) { return f.id === id; })[0];
    if (!cur) return;
    $('foldersView').hidden = true; $('folderView').hidden = false;
    $('fname').textContent = cur.name; $('editName').value = cur.name; $('editGlow').value = cur.glow || '#ffc107';
    $('photoState').textContent = cur.image_key ? 'Photo set' : 'No photo yet';
    $('folderErr').textContent = ''; $('uploads').innerHTML = '';
    loadItems();
  }
  $('back').onclick = function () { cur = null; showFolderList(); loadFolders(); };

  $('saveEdit').onclick = async function () {
    $('folderErr').textContent = '';
    try {
      await post('/speakers', { id: cur.id, category: cur.category, name: $('editName').value, glow: $('editGlow').value, sort: cur.sort });
      cur.name = $('editName').value; cur.glow = $('editGlow').value; $('fname').textContent = cur.name;
      $('folderErr').textContent = 'Saved';
    } catch (e) { $('folderErr').textContent = e.message; }
  };
  $('photoBtn').onclick = function () { $('photoFile').click(); };
  $('photoFile').onchange = async function () {
    var f = $('photoFile').files[0]; if (!f) return;
    $('folderErr').textContent = 'Uploading photo...';
    try {
      var r = await api('/speakers/' + enc(cur.id) + '/photo?filename=' + enc(f.name), { method: 'PUT', body: f });
      cur.image_key = r.image_key; $('photoState').textContent = 'Photo updated'; $('folderErr').textContent = '';
    } catch (e) { $('folderErr').textContent = e.message; }
    $('photoFile').value = '';
  };
  $('delFolder').onclick = async function () {
    if (!confirm('Delete the folder "' + cur.name + '"? It must be empty.')) return;
    try { await api('/speakers/' + enc(cur.id), { method: 'DELETE' }); cur = null; showFolderList(); loadFolders(); }
    catch (e) { $('folderErr').textContent = e.message; }
  };

  // ---- items ----
  async function loadItems() {
    var box = $('items'); box.innerHTML = '';
    try {
      var list = await api('/speakers/' + enc(cur.id) + '/items');
      $('itemsTitle').textContent = 'Items (' + list.length + ')';
      if (!list.length) box.appendChild(el('p', { class: 'muted', text: 'Nothing here yet.' }));
      list.forEach(function (it) {
        var t = el('div', { class: 't', text: it.title });
        box.appendChild(el('div', { class: 'item' }, [
          t,
          el('button', { class: 'ghost', text: 'Rename', onclick: async function () {
            var n = prompt('New title', it.title); if (!n || !n.trim()) return;
            try { await api('/items/' + enc(it.id), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: n }) }); loadItems(); }
            catch (e) { alert(e.message); }
          } }),
          el('button', { class: 'danger', text: 'Delete', onclick: async function () {
            if (!confirm('Delete "' + it.title + '"? The audio file is removed too.')) return;
            try { await api('/items/' + enc(it.id), { method: 'DELETE' }); loadItems(); }
            catch (e) { alert(e.message); }
          } })
        ]));
      });
    } catch (e) { box.appendChild(el('p', { class: 'err', text: e.message })); }
  }

  // ---- uploads ----
  function getDuration(file) {
    return new Promise(function (resolve) {
      var a = document.createElement('audio'); var url = URL.createObjectURL(file);
      var done = function (v) { URL.revokeObjectURL(url); resolve(v); };
      a.preload = 'metadata';
      a.onloadedmetadata = function () { done(isFinite(a.duration) ? Math.round(a.duration) : 0); };
      a.onerror = function () { done(0); };
      setTimeout(function () { done(0); }, 8000);
      a.src = url;
    });
  }
  function titleOf(name) { return name.replace(/\.[A-Za-z0-9]+$/, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim(); }

  async function uploadOne(file, row, bar, status) {
    var started = null;
    try {
      if (!file.size) throw new Error('File is empty');
      status.textContent = 'Reading...';
      var dur = await getDuration(file);
      started = await post('/upload/start', { speaker_id: cur.id, filename: file.name });
      var parts = [], n = 0, total = Math.ceil(file.size / CHUNK);
      for (var off = 0; off < file.size; off += CHUNK) {
        n++;
        var blob = file.slice(off, off + CHUNK), tries = 0, res = null;
        while (!res) {
          try {
            res = await api('/upload/part?key=' + enc(started.key) + '&uploadId=' + enc(started.uploadId) + '&n=' + n, { method: 'PUT', body: blob });
          } catch (e) { if (++tries >= 3) throw e; await sleep(1000 * tries); }
        }
        parts.push(res);
        bar.style.width = Math.round((n / total) * 95) + '%';
        status.textContent = 'Uploading ' + n + '/' + total;
      }
      status.textContent = 'Finishing...';
      await post('/upload/complete', { key: started.key, uploadId: started.uploadId, parts: parts, speaker_id: cur.id, title: titleOf(file.name), duration_sec: dur });
      bar.style.width = '100%'; status.textContent = 'Done'; status.style.color = '#7CFFB2';
      return true;
    } catch (e) {
      status.textContent = 'Failed: ' + e.message; status.style.color = '#ff8a80';
      if (started) { try { await post('/upload/abort', { key: started.key, uploadId: started.uploadId }); } catch (x) {} }
      return false;
    }
  }

  async function handleFiles(files) {
    if (!cur) return;
    var list = Array.prototype.slice.call(files);
    var box = $('uploads');
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var status = el('span', { class: 'muted', text: 'Waiting...' });
      var bar = el('i');
      box.appendChild(el('div', { class: 'up' }, [el('div', { text: f.name }), status, el('div', { class: 'bar' }, [bar])]));
      await uploadOne(f, null, bar, status);
    }
    loadItems();
  }
  $('drop').onclick = function () { $('audioFiles').click(); };
  $('audioFiles').onchange = function () { handleFiles($('audioFiles').files); $('audioFiles').value = ''; };
  $('drop').ondragover = function (e) { e.preventDefault(); $('drop').classList.add('over'); };
  $('drop').ondragleave = function () { $('drop').classList.remove('over'); };
  $('drop').ondrop = function (e) { e.preventDefault(); $('drop').classList.remove('over'); handleFiles(e.dataTransfer.files); };

  if (token) { showApp(true); renderTabs(); loadFolders(); }
})();
</script>
</body>
</html>`;
