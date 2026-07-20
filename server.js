// 9d-cicd — test dashboard for 9d-mobile.
// Zero-dependency Node server. Two suites, shown as separate tabs in the UI:
//   unit → 9d-mobile/scripts/run-all-unittest.sh   (doctest host unit tests)
//   ui   → 9d-mobile/scripts/run-all-uitest.sh      (in-app UI + logic tests on the real mac build)
// Both speak the same tab-separated marker protocol (##PHASE/##TC_LIST/##TC_START/##TC_PASS/
// ##TC_FAIL/##SUMMARY). Per-case status streams to the browser via SSE.
//
//   node server.js            → http://localhost:4909
//   PORT=8080 node server.js
//   MOBILE_REPO=/path/to/9d-mobile node server.js

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 4909);
const MOBILE_REPO = process.env.MOBILE_REPO || path.resolve(__dirname, '..', '9d-mobile');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'last-run.json');
const MAX_LOG_LINES = 2000;
const MAX_HISTORY = 30;

// suite registry -----------------------------------------------------------------------------------
const SUITES = {
  unit: { label: 'Unit Test',          script: path.join(MOBILE_REPO, 'scripts', 'run-all-unittest.sh'), args: [] },
  ui:   { label: 'UI Test (app thật)', script: path.join(MOBILE_REPO, 'scripts', 'run-all-uitest.sh'),   args: [] },
};

function makeState() {
  return {
    status: 'idle', phase: null, startedAt: null, finishedAt: null, exitCode: null, error: null,
    tests: [], summary: null, log: [], history: [], child: null,
  };
}
const states = { unit: makeState(), ui: makeState() };
const sseClients = new Set();

// persistence --------------------------------------------------------------------------------------
function loadPersisted() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // migration: the old single-suite format persisted unit fields at top level.
    const legacy = saved.tests ? { unit: saved } : saved;
    for (const k of Object.keys(SUITES)) {
      const s = legacy[k]; if (!s) continue;
      Object.assign(states[k], {
        tests: s.tests || [], summary: s.summary || null, startedAt: s.startedAt || null,
        finishedAt: s.finishedAt || null, exitCode: s.exitCode ?? null, history: s.history || [],
        phase: (s.tests && s.tests.length) ? 'done' : null,
      });
    }
  } catch { /* first boot */ }
}
function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = {};
    for (const k of Object.keys(SUITES)) {
      const s = states[k];
      out[k] = { tests: s.tests, summary: s.summary, startedAt: s.startedAt,
                 finishedAt: s.finishedAt, exitCode: s.exitCode, history: s.history };
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(out, null, 2));
  } catch (e) { console.error('persist failed:', e.message); }
}

// SSE --------------------------------------------------------------------------------------------
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}
function publicState(k) {
  const s = states[k];
  return {
    suite: k, label: SUITES[k].label, status: s.status, phase: s.phase, startedAt: s.startedAt,
    finishedAt: s.finishedAt, exitCode: s.exitCode, error: s.error, tests: s.tests,
    summary: s.summary, history: s.history, mobileRepo: MOBILE_REPO,
  };
}
function allStates(withLog) {
  const o = {};
  for (const k of Object.keys(SUITES)) o[k] = withLog ? { ...publicState(k), log: states[k].log } : publicState(k);
  return o;
}
function pushLog(k, line) {
  const s = states[k];
  s.log.push(line);
  if (s.log.length > MAX_LOG_LINES) s.log.splice(0, s.log.length - MAX_LOG_LINES);
  broadcast('log', { suite: k, line });
}

// runner -----------------------------------------------------------------------------------------
function findTest(k, name) { return states[k].tests.find(t => t.name === name); }

function handleMarker(k, parts) {
  const s = states[k], tag = parts[0];
  if (tag === '##PHASE') {
    s.phase = parts[1];
    // The script has finished discovery once the run phase starts: drop cases that
    // no longer exist (e.g. renamed accounts.ini labels) and match the script's order,
    // so the table stays in sync with what run-all-*.sh will actually execute.
    if (s.phase === 'run' && s.listed && s.listed.size) {
      const byName = new Map(s.tests.map(t => [t.name, t]));
      s.tests = [...s.listed].map(name => byName.get(name)).filter(Boolean);
      broadcast('tests', { suite: k, tests: s.tests });
    }
    broadcast('phase', { suite: k, phase: s.phase });
  }
  else if (tag === '##TC_LIST') {
    const name = parts[1];
    if (s.listed) s.listed.add(name);
    if (!findTest(k, name)) s.tests.push({ name, status: 'pending', durationMs: null, finishedAt: null, detail: null });
    else Object.assign(findTest(k, name), { status: 'pending', durationMs: null, detail: null });
    broadcast('tests', { suite: k, tests: s.tests });
  } else if (tag === '##TC_START') {
    const t = findTest(k, parts[1]); if (t) { t.status = 'running'; broadcast('test', { suite: k, test: t }); }
  } else if (tag === '##TC_PASS' || tag === '##TC_FAIL') {
    const t = findTest(k, parts[1]);
    if (t) {
      t.status = tag === '##TC_PASS' ? 'passed' : 'failed';
      t.durationMs = Number(parts[2] || 0);
      // detail is the trailing field — keep any tabs it happens to contain
      t.detail = tag === '##TC_FAIL' ? (parts.slice(3).join('\t') || '') : null;
      t.finishedAt = new Date().toISOString();
      broadcast('test', { suite: k, test: t });
    }
  } else if (tag === '##SUMMARY') {
    s.summary = { total: Number(parts[1]), passed: Number(parts[2]), failed: Number(parts[3]) };
    broadcast('summary', { suite: k, summary: s.summary });
  }
}

function startRun(k) {
  const s = states[k];
  if (!SUITES[k]) return { ok: false, error: `Unknown suite: ${k}` };
  if (s.status === 'running') return { ok: false, error: 'A run is already in progress' };
  if (!fs.existsSync(SUITES[k].script)) return { ok: false, error: `Script not found: ${SUITES[k].script}` };

  Object.assign(s, { status: 'running', phase: 'configure', startedAt: new Date().toISOString(),
                     finishedAt: null, exitCode: null, error: null, log: [],
                     summary: null, listed: new Set() });
  s.tests.forEach(t => { t.status = 'pending'; t.durationMs = null; t.detail = null; });
  broadcast('run-start', publicState(k));

  s.child = spawn('bash', [SUITES[k].script, ...SUITES[k].args], { cwd: MOBILE_REPO });
  let buf = '';
  const onChunk = (chunk) => {
    buf += chunk.toString('utf8'); let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, ''); buf = buf.slice(idx + 1);
      if (line.startsWith('##')) handleMarker(k, line.split('\t'));
      else if (line.trim()) pushLog(k, line);
    }
  };
  s.child.stdout.on('data', onChunk);
  s.child.stderr.on('data', onChunk);
  s.child.on('close', (code) => {
    Object.assign(s, { status: 'idle', exitCode: code, finishedAt: new Date().toISOString() });
    if (code !== 0 && code !== 1) {
      s.phase = 'error';
      s.error = `${path.basename(SUITES[k].script)} exited with code ${code} (setup/build error)`;
      s.tests.forEach(t => { if (t.status === 'pending' || t.status === 'running') t.status = 'failed'; });
    } else { s.phase = 'done'; }
    s.history.unshift({ startedAt: s.startedAt, finishedAt: s.finishedAt,
      total: s.summary ? s.summary.total : s.tests.length,
      passed: s.summary ? s.summary.passed : 0, failed: s.summary ? s.summary.failed : 0, exitCode: code });
    if (s.history.length > MAX_HISTORY) s.history.length = MAX_HISTORY;
    s.child = null; persist(); broadcast('run-end', publicState(k));
  });
  return { ok: true };
}

// http -------------------------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const suite = url.searchParams.get('suite') || 'unit';

  if (url.pathname === '/api/state') {
    if (!SUITES[suite]) { res.writeHead(404); res.end('unknown suite'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ...publicState(suite), log: states[suite].log }));
    return;
  }
  if (url.pathname === '/api/run' && req.method === 'POST') {
    const r = startRun(suite);
    res.writeHead(r.ok ? 202 : 409, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(r));
    return;
  }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify({ suites: allStates(true) })}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const fp = path.join(__dirname, 'public', path.normalize(file));
  if (!fp.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); res.end(); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

loadPersisted();
server.listen(PORT, () => {
  console.log(`9d-cicd test dashboard → http://localhost:${PORT}`);
  console.log(`9d-mobile repo: ${MOBILE_REPO}`);
});
