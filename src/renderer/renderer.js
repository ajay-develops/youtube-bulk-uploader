'use strict';
const $ = (id) => document.getElementById(id);
let state = null;
let settingsDirty = false;

// Build DOM with textContent only -- file names and errors are untrusted text.
function cell(tr, text, link) {
  const td = document.createElement('td');
  if (link) {
    const a = document.createElement('a');
    a.textContent = text;
    a.onclick = link;
    td.appendChild(a);
  } else td.textContent = text;
  tr.appendChild(td);
}
function table(el, heads, rows) {
  el.replaceChildren();
  if (!rows.length) {
    el.textContent = 'Nothing here.';
    return;
  }
  const t = document.createElement('table');
  const hr = t.insertRow();
  heads.forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    hr.appendChild(th);
  });
  rows.forEach((r) => {
    const tr = t.insertRow();
    r.forEach((c) => (typeof c === 'string' ? cell(tr, c) : cell(tr, c.text, c.link)));
  });
  el.appendChild(t);
}

function untilReset(at) {
  const mins = Math.max(1, Math.ceil((at - Date.now()) / 60000));
  const h = Math.floor(mins / 60), m = mins % 60;
  const part = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (!h) return part(m, 'minute');
  return m ? `${part(h, 'hour')} ${part(m, 'minute')}` : part(h, 'hour');
}

function mb(n) {
  return (n / 1048576).toFixed(0) + ' MB';
}

function render(s) {
  state = s;
  const pill = $('pill');
  if (s.running) [pill.textContent, pill.className] = ['Uploading', 'pill busy'];
  else if (s.paused) [pill.textContent, pill.className] = ['Paused', 'pill warn'];
  else [pill.textContent, pill.className] = ['Idle', 'pill ok'];

  $('btn-run').hidden = s.running;
  $('btn-run').disabled = s.paused;
  $('btn-stop').hidden = !s.running;
  $('btn-pause').textContent = s.paused ? 'Resume uploads' : 'Pause uploads';

  const warn = [];
  if (!s.auth.signedIn) warn.push('Not signed in to YouTube — open Settings.');
  if (!s.ssdConnected) warn.push('Source folder not found — is the SSD connected? ' + s.config.sourceRoot);
  if (s.auth.signedIn && !s.auth.canCheckDuplicates) warn.push('Optional: sign in again (Settings) to enable duplicate protection.');
  if (s.quotaHit) warn.push(`YouTube's daily upload limit reached. Resumes in ${untilReset(s.quotaResetAt)}`);
  $('banner').hidden = !warn.length;
  $('banner').textContent = warn.join('  ');

  $('s-up').textContent = s.counts.uploaded;
  $('s-pend').textContent = s.counts.pending;
  $('s-fail').textContent = s.counts.failed;
  $('s-today').textContent = `${s.todayCount}/${s.config.dailyCap}`;

  $('current').hidden = !s.current;
  if (s.current) {
    $('cur-title').textContent = s.current.title;
    $('cur-bar').style.width = Math.round(s.current.progress * 100) + '%';
    $('cur-meta').textContent = `${Math.round(s.current.progress * 100)}% — ${mb(s.current.bytes)} of ${mb(s.current.size)}`;
  }

  table($('tab-recent'), ['Title', 'Link', 'Uploaded (UTC)'],
    s.recent.map((e) => [e.title || e.key, { text: 'watch', link: () => window.api.openVideo(e.youtube_id) }, e.uploaded_at || '']));
  table($('tab-queue'), ['File'], s.queue.map((k) => [k]));
  table($('tab-failed'), ['File', 'Error', 'Attempts'], s.failed.map((e) => [e.key, (e.last_error || '').slice(0, 200), String(e.attempts || 0)]));
  const log = $('tab-log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.textContent = s.log.join('\n');
  if (atBottom) log.scrollTop = log.scrollHeight;

  if (!settingsDirty) {
    $('f-root').value = s.config.sourceRoot;
    $('f-cap').value = s.config.dailyCap;
    $('f-privacy').value = s.config.privacy;
    $('f-auto').value = s.config.autoRunMinutes;
  }
  $('auth-status').textContent =
    (s.auth.hasClientSecret ? 'Client secret: present. ' : 'Client secret: missing. ') +
    (s.auth.signedIn ? 'Signed in.' : 'Not signed in.');
}

document.querySelectorAll('nav button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== 'tab-' + b.dataset.tab));
  };
});
['f-cap', 'f-privacy', 'f-auto'].forEach((id) => ($(id).oninput = () => (settingsDirty = true)));

$('btn-run').onclick = () => window.api.run();
$('btn-stop').onclick = () => window.api.stop();
$('btn-pause').onclick = () => window.api.setPaused(!state.paused);
$('btn-folder').onclick = () => window.api.chooseFolder();
$('btn-save').onclick = async () => {
  await window.api.setConfig({
    dailyCap: Number($('f-cap').value),
    privacy: $('f-privacy').value,
    autoRunMinutes: Number($('f-auto').value),
  });
  settingsDirty = false;
};
$('btn-retry').onclick = () => window.api.retryFailed();
$('btn-secret').onclick = () => window.api.importClientSecret();
$('btn-signin').onclick = async () => {
  const r = await window.api.signIn();
  if (!r.ok) $('auth-status').textContent = 'Sign-in failed: ' + r.error;
};
$('btn-signout').onclick = () => window.api.signOut();

window.api.onState(render);
setInterval(() => state && render(state), 30000); // keep the countdown fresh
window.api.getState().then(render);
