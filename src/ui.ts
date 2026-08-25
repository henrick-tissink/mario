// The web UI: three server-rendered shells that fetch their own data.
//
// Everything interpolated into HTML goes through `h`, which escapes by default.
// In the system this replaces exactly one field was escaped and the rest — repo
// paths, project names, actor names — went into innerHTML raw, all of them
// originating in agent-supplied emit payloads. A filename may legally contain
// `<`, so that was a live stored-XSS path on a page served from the same origin
// as the endpoint-minting API.

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

const CSS = `
:root {
  --bg:#f7f5f2; --panel:#fffefc; --line:#e3ded6; --ink:#1f1c19; --muted:#6b635a;
  --accent:#b4501e; --code:#f1ede7; --hot:#c0392b;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg:#16150f; --panel:#1e1d17; --line:#33302a; --ink:#ece7de; --muted:#a09788;
    --accent:#e8944f; --code:#24231c; --hot:#ff6b4a;
  }
}
:root[data-theme="dark"] {
  --bg:#16150f; --panel:#1e1d17; --line:#33302a; --ink:#ece7de; --muted:#a09788;
  --accent:#e8944f; --code:#24231c; --hot:#ff6b4a;
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink);
  font:16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width:60rem; margin:0 auto; padding:3rem 1.5rem 5rem; }
nav { display:flex; gap:1.25rem; align-items:baseline; margin-bottom:2.5rem; }
nav a { color:var(--accent); text-decoration:none; }
nav strong { font-weight:700; }
h1 { font-size:1.6rem; margin:0 0 .3rem; letter-spacing:-.01em; }
h2 { font-size:1rem; margin:2.2rem 0 .6rem; }
.sub { color:var(--muted); margin:0 0 2rem; }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:10px;
  padding:1.1rem 1.3rem; }
table { width:100%; border-collapse:collapse; font-size:.95rem; }
td { padding:.5rem; border-bottom:1px solid var(--line); vertical-align:top; }
tr:last-child td { border-bottom:0; }
td.who { font-weight:600; width:9rem; }
td.when { text-align:right; color:var(--muted); white-space:nowrap; width:7rem; }
code { background:var(--code); padding:.1rem .35rem; border-radius:4px; font-size:.88em; }
.muted { color:var(--muted); }
.proj { font-weight:600; color:var(--accent); margin-right:.35rem; }
.badge { display:inline-block; background:var(--accent); color:#fff; font-size:.75rem;
  font-weight:700; padding:.1rem .45rem; border-radius:999px; }
button { font:inherit; font-weight:600; cursor:pointer; border-radius:8px;
  border:1px solid var(--accent); background:var(--accent); color:#fff; padding:.55rem 1rem; }
button.ghost { background:transparent; color:var(--accent); }
button.small { padding:.2rem .55rem; font-size:.82rem; font-weight:500; }
button:disabled { opacity:.55; cursor:default; }
pre { background:var(--code); border:1px solid var(--line); border-radius:8px;
  padding:.8rem 1rem; overflow-x:auto; white-space:pre-wrap;
  font:13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.row { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; margin-top:.7rem; }
.hide { display:none; }
`;

// Client script. It never builds HTML from a string: every value goes in through
// textContent, so escaping cannot be forgotten at a call site.
const JS = String.raw`
const $ = (id) => document.getElementById(id);
const api = (path, opts = {}) =>
  fetch('/api' + path, { ...opts, headers: { 'x-mario': '1', ...(opts.headers || {}) } });
const ago = (ts) => {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  return h < 48 ? h + 'h ago' : Math.round(h / 24) + 'd ago';
};
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};

async function renderWho() {
  const d = await (await api('/who')).json();
  $('window').textContent = 'Last ' + d.hours + ' hours.';
  const body = $('people');
  body.replaceChildren();
  if (!d.people.length) {
    const tr = el('tr'); const td = el('td', 'Nobody yet — either a quiet day, or nothing is emitting.', 'muted');
    tr.append(td); body.append(tr);
  }
  for (const p of d.people) {
    const tr = el('tr');
    tr.append(el('td', p.actor.split('@')[0], 'who'));
    const where = el('td');
    for (const pr of p.projects) {
      const line = el('div');
      line.append(el('span', pr.project, 'proj'));
      if (!pr.areas.length) line.append(el('span', '—', 'muted'));
      for (const a of pr.areas) { line.append(el('code', a)); line.append(document.createTextNode(' ')); }
      where.append(line);
    }
    tr.append(where);
    tr.append(el('td', ago(p.ts), 'when'));
    body.append(tr);
  }
  $('folds').textContent = d.folds.length
    ? 'Last folded — ' + d.folds.map((f) => f.project + ' ' + ago(f.updated_at)).join(' · ')
    : 'No folds yet. Luigi runs every 4h and needs events older than the decay window.';
  $('findings').replaceChildren();
  const a = el('a', d.openFindings + ' open finding' + (d.openFindings === 1 ? '' : 's'));
  a.href = '/findings';
  $('findings').append(a);
}

let showing = 'open';
async function renderFindings() {
  const d = await (await api('/findings?status=' + showing)).json();
  const body = $('flist');
  body.replaceChildren();
  if (!d.findings.length) {
    const tr = el('tr');
    tr.append(el('td', showing === 'open'
      ? 'Nothing open. Either the code is in good shape, or agents are not recording what they hit — check that the agent rules block is in your CLAUDE.md.'
      : 'Nothing closed yet.', 'muted'));
    body.append(tr); return;
  }
  for (const f of d.findings) {
    const tr = el('tr');
    const count = el('td', null, 'when');
    if (f.seen_count > 1) count.append(el('span', 'x' + f.seen_count, 'badge'));
    tr.append(count);
    const main = el('td');
    main.append(el('div', f.summary));
    const meta = el('div');
    meta.style.marginTop = '.25rem';
    meta.append(el('span', f.project, 'proj'));
    let paths = [];
    try { paths = JSON.parse(f.paths || '[]'); } catch {}
    for (const p of paths.slice(0, 3)) { meta.append(el('code', p)); meta.append(document.createTextNode(' ')); }
    if (f.close_note) meta.append(el('span', ' closed: ' + f.close_note, 'muted'));
    main.append(meta);
    tr.append(main);
    tr.append(el('td', ago(f.updated_at), 'when'));
    const act = el('td', null, 'when');
    if (showing === 'open') {
      const b = el('button', 'Close', 'ghost small');
      b.onclick = async () => {
        b.disabled = true;
        await api('/findings/' + f.id + '/close', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        renderFindings();
      };
      act.append(b);
    }
    tr.append(act);
    body.append(tr);
  }
}

async function renderSetup() {
  const me = await (await api('/me')).json();
  $('who').textContent = me.actor;
  if (me.has_endpoint) {
    $('warn').textContent = 'You already have an endpoint (created ' + ago(me.endpoint_created) +
      '). It was shown once and cannot be retrieved. Creating a new one retires the old, so only do ' +
      'this if you have lost it or are setting up another machine — you will need to re-run the installer.';
    $('warn').classList.remove('hide');
    $('mint').textContent = 'Replace my endpoint';
  }
  $('mint').onclick = async () => {
    $('mint').disabled = true;
    const r = await (await api('/endpoint', { method: 'POST' })).json();
    $('url').textContent = r.endpoint;
    $('url').classList.remove('hide');
    $('cmd').textContent = 'git clone <this repo> && cd mario && ./install.sh "' + r.endpoint + '"';
    $('warn').textContent = 'Shown once — only a hash is stored, so it cannot be recovered. Copy it now.';
    $('warn').classList.remove('hide');
    $('mint').textContent = 'Create a new one';
    $('mint').disabled = false;
  };
}
`;

const NAV = (active: string) =>
  ['who', 'findings', 'setup']
    .map((k) => {
      const href = k === 'who' ? '/' : `/${k}`;
      const label = k === 'who' ? 'Mario' : k[0]!.toUpperCase() + k.slice(1);
      return k === active ? `<strong>${label}</strong>` : `<a href="${href}">${label}</a>`;
    })
    .join(' ');

const BODIES: Record<string, string> = {
  who: `
  <h1>Who's about</h1>
  <p class="sub" id="window">Loading…</p>
  <div class="panel"><table><tbody id="people"></tbody></table></div>
  <h2>Health</h2>
  <div class="panel"><p id="folds" class="muted">…</p><p id="findings" class="muted">…</p></div>
  <p class="sub" style="margin-top:2.5rem">Areas are shown per project, so <code>src/worker/</code>
  in one repo is not confused with another. Presence and last-seen only — no counts, no durations,
  no ranking.</p>
  <script>renderWho(); setInterval(renderWho, 60000);</script>`,

  findings: `
  <h1>Findings</h1>
  <p class="sub">Problems agents noticed while working on something else.</p>
  <div class="row" style="margin-bottom:1rem">
    <button id="toggle" class="ghost small">Show closed</button>
  </div>
  <div class="panel"><table><tbody id="flist"></tbody></table></div>
  <p class="sub" style="margin-top:2.5rem">A count means several agents reported the same thing
  independently — near-identical wording is collapsed on write rather than filed twice. Closing is
  not deletion: if an agent hits the same problem again it reopens itself, which is the signal it
  was not really fixed.</p>
  <script>
    renderFindings();
    $('toggle').onclick = () => {
      showing = showing === 'open' ? 'closed' : 'open';
      $('toggle').textContent = showing === 'open' ? 'Show closed' : 'Show open';
      renderFindings();
    };
  </script>`,

  setup: `
  <h1>Set up your machine</h1>
  <p class="sub">Two minutes. Your agent can do all of it.</p>
  <h2>1. Get your endpoint</h2>
  <div class="panel">
    <p>Signed in as <strong id="who">…</strong>. Your endpoint is a personal URL that identifies you
    to the system — treat it like a password and do not paste it in a channel. Sharing it does not
    fail loudly; it silently attributes your work to whoever it was minted for.</p>
    <p id="warn" class="muted hide"></p>
    <div class="row"><button id="mint">Create my endpoint</button></div>
    <pre id="url" class="hide"></pre>
  </div>
  <h2>2. Install</h2>
  <div class="panel">
    <pre id="cmd">git clone &lt;this repo&gt; &amp;&amp; cd mario &amp;&amp; ./install.sh "&lt;your-endpoint-url&gt;"</pre>
    <p class="muted">If you use Codex, run <code>codex</code> interactively once afterwards and accept
    the hook-trust prompt. Until you do, Codex fires no hooks and reports no error.</p>
  </div>
  <h2>3. Check it worked</h2>
  <div class="panel"><pre>cd ~/some/work/repo
mario scope     # should say IN scope
mario check     # who else is in this code right now
mario who       # the team's activity</pre></div>
  <h2>What gets sent</h2>
  <div class="panel">
    <p>Only for repos in scope. Personal repos and third-party clones never leave your machine: the
    CLI refuses before making a network call, and the server rejects it independently. Run
    <code>mario scope</code> in any repo to check.</p>
    <p>There are no per-person statistics anywhere in this system — no leaderboards, no time-on-task.
    Everything is organised by project and code area. Your name appears only as "who is currently in
    this file", which is the collision signal and nothing else.</p>
  </div>
  <script>renderSetup();</script>`,
};

export function page(active: string): string {
  const title = active === 'who' ? 'Mario' : `${active[0]!.toUpperCase()}${active.slice(1)} — Mario`;
  // The shared script lives in <head> so its declarations exist before the
  // per-page script at the end of <body> calls them. It only declares; it
  // touches no DOM at parse time.
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
<script>${JS}</script>
</head><body>
<main>
<nav>${NAV(active)}</nav>
${BODIES[active] ?? '<p>not found</p>'}
</main>
</body></html>`;
}
