#!/usr/bin/env node
/*
 * supervisor.js - lazy local-model manager for llama.cpp behind an OpenAI-compatible endpoint.
 *
 * WHY THIS EXISTS
 *   DSH's local routes go through @deepseek-ai/dsh-llm-pi-ai, which is a plain OpenAI-compatible
 *   HTTP client: it can only POST to a baseURL. It has no hook that could start a process, so
 *   "start the model when something needs it" cannot be implemented inside DSH's provider.
 *   It has to be intercepted at the HTTP layer.
 *
 * HOW IT WORKS
 *   The supervisor listens on the ports the client already points at and runs
 *   llama-server on private internal ports (9080 / 9081). DSH therefore needs NO config change.
 *
 *     DSH ──> 127.0.0.1:8081 (supervisor) ──> 127.0.0.1:9081 (llama-server, started on demand)
 *
 *   * first inference request  -> spawn llama-server, wait for /health, then proxy
 *   * 500s with no inference   -> kill llama-server, VRAM is released
 *   * lightweight metadata calls (/health, /v1/models) NEVER start the model, so a polling
 *     client cannot keep the GPU pinned forever
 *   * only one model runs at a time (a 12 GB card cannot hold both); asking for the other one
 *     stops the current model first
 *   * SOFT CONTEXT CEILING ("fake overflow"): a request whose templated prompt exceeds
 *     softContextLimit is rejected with llama.cpp's own exceed_context_size_error even though the
 *     real --ctx-size would still accept it. DSH classifies that wording as CONTEXT_WINDOW_EXCEEDED
 *     and compacts; the untouched remainder of the real window is the redundancy that lets the
 *     summarization request actually run. Set softContextLimit to 0 to disable.
 *
 * CONTROL ENDPOINTS (available on every public port)
 *   GET  /__supervisor/status   -> JSON: what runs, idle countdown, last use
 *   POST /__supervisor/unload   -> stop every running local model right now
 *
 * Usage: node supervisor.js [config.json]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CONFIG_PATH = process.argv[2] || path.join(__dirname, 'models.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const IDLE_MS = (cfg.idleTimeoutSec ?? 500) * 1000;
const CHECK_MS = (cfg.checkIntervalSec ?? 5) * 1000;
const START_TIMEOUT_MS = (cfg.startTimeoutSec ?? 300) * 1000;
const STOP_GRACE_MS = (cfg.stopGraceSec ?? 20) * 1000;
// After a soft-ceiling rejection, requests are allowed past the ceiling for this long. That is
// the window in which DSH issues its summarization replay, which is LARGER than the ceiling when
// a single turn added a lot of history (a big tool result, say). Without it the replay would be
// rejected too and compaction could never complete.
const SOFT_GRACE_MS = (cfg.softGraceSec ?? 180) * 1000;
// llama-server reports /health ok a moment BEFORE it can survive a large first request: the first
// big prefill allocates extra compute buffers (with -fa on and q8_0/q4_0 KV, flash attention falls
// back to converting K/V to f16), and on a 12 GB card that briefly-tight VRAM is enough to kill a
// freshly started process. A tiny warm-up completion plus this settle delay removes the race.
const SETTLE_MS = (cfg.startSettleSec ?? 1.5) * 1000;

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'supervisor.log');
fs.mkdirSync(LOG_DIR, { recursive: true });

// One persistent handle with buffered writes, instead of fs.appendFileSync per line. llama.cpp is
// chatty, so the old version opened/wrote/closed the file thousands of times — file-handle churn
// plus a steady stream of temporary strings. Nothing is duplicated to stdout either: the launcher
// already redirects stdout into a file, so console.log wrote every single line TWICE.
const LOG_STREAM = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(msg) {
  try { LOG_STREAM.write(`${new Date().toISOString()} ${msg}\n`) } catch { /* logging must never crash us */ }
}

/** The few lines that should also land in the launcher's stdout log. */
function logConsole(msg) {
  try { process.stdout.write(`${new Date().toISOString()} ${msg}\n`) } catch { }
  log(msg);
}

// llama.cpp's routine output (load tensors, slot timings, graph reuse) is dropped by default:
// it dominated the log file and this process's allocation churn for no operational value.
// Warnings, errors and a few meaningful phrases are kept. Use --child-log for everything.
const CHILD_LOG_ALL = process.argv.includes('--child-log') || process.env.SUPERVISOR_CHILD_LOG === '1';

// Bounded keep-alive pool for upstream sockets. Node's global agent keeps sockets alive after
// each request; without a cap, a burst of requests leaves a pile of open sockets behind, which is
// where the supervisor's ~280 handles came from.
const UPSTREAM_AGENT = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2, timeout: 30000 });
/* --------------------------------------------------- model list normalization */

// ONE unified list accepts both kinds of local model source:
//
//   { "name": "a", "path": "D:\\models\\a.gguf" }         -> the supervisor spawns llama-server,
//                                                             cold-starts it and releases it when idle
//   { "name": "b", "url": "http://127.0.0.1:11434/v1" }   -> an already-running OpenAI-compatible
//                                                             server (Ollama, LM Studio, vLLM, another
//                                                             llama.cpp): forwarded to, never stopped
//
// Ports are allocated automatically unless an entry sets them explicitly, and the legacy explicit
// schema (publicPort / internalPort / model / args) keeps working unchanged.
const COMMON = cfg.common || cfg.llamaServer || {};
const PORT_BASE_PUBLIC = cfg.ports?.publicBase ?? 8080;
const PORT_BASE_INTERNAL = cfg.ports?.internalBase ?? 9080;
const DEFAULTS = cfg.defaults || {};
const DEFAULT_SOFT_RATIO = DEFAULTS.softContextRatio ?? 0.75;

/** Last value of a CLI flag inside an args array. */
function argValue(args, flag) {
  const a = Array.isArray(args) ? args : [];
  const i = a.lastIndexOf(flag);
  return i >= 0 ? a[i + 1] : undefined;
}

/** Split an OpenAI-compatible base URL into host / port / path. */
function parseTarget(url) {
  const u = new URL(url);
  let base = u.pathname.replace(/\/+$/, '');
  if (!base) base = '/v1';                 // "http://host:port" means the usual /v1 base
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return { host: u.hostname, port, base };
}

function normalizeModels(list) {
  const raws = list || [];

  // ---- pass 1: public ports (every model gets one) --------------------------------------
  const usedPorts = new Set();
  const publicPorts = raws.map((raw, i) => {
    const p = raw.publicPort ?? (PORT_BASE_PUBLIC + i);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`"${raw.name || raw.key || i}" has an invalid publicPort: ${raw.publicPort}`);
    if (usedPorts.has(p)) throw new Error(`public port ${p} is claimed more than once — set "publicPort" explicitly to resolve it`);
    usedPorts.add(p);
    return p;
  });

  // ---- pass 2: internal ports (managed models only), skipping anything already claimed ----
  return raws.map((raw, i) => {
    const m = { ...raw };
    m.key = raw.key || raw.name || `model-${i + 1}`;
    m.label = raw.label || m.key;
    m.publicPort = publicPorts[i];
    m.external = !!raw.url;

    if (m.external) {
      const t = parseTarget(raw.url);
      m.targetHost = t.host;
      m.targetPort = t.port;
      m.targetBase = t.base;
      m.alias = raw.alias || m.key;
      m.ctxSize = raw.ctxSize ?? null;       // unknown unless the user declares it
    } else {
      if (raw.internalPort != null) {
        if (usedPorts.has(raw.internalPort)) throw new Error(`internal port ${raw.internalPort} of "${m.key}" is already taken`);
        m.internalPort = raw.internalPort;
      } else {
        // Walk up from the base until a free port is found, so a public/internal base pair that
        // overlaps (8080 / 8081, say) can never hand the same port to two things.
        let p = PORT_BASE_INTERNAL;
        while (usedPorts.has(p)) p++;
        m.internalPort = p;
      }
      usedPorts.add(m.internalPort);

      m.model = raw.path || raw.model;
      if (!m.model) throw new Error(`model "${m.key}" needs either "path" (a .gguf file) or "url"`);
      if (Array.isArray(raw.args)) {
        m.args = raw.args;                   // advanced/legacy: exactly what the user wrote
        // Keep the id llama-server is actually told to serve under, so /v1/models stays truthful.
        m.alias = raw.alias || argValue(m.args, '--alias') || argValue(COMMON.args, '--alias') || m.key;
      } else {
        // Simple schema: only "path" is required; everything else comes from `defaults`.
        // Each model gets its own --alias so several managed models stay distinguishable.
        m.alias = raw.alias || m.key;
        const ctx = raw.ctxSize ?? DEFAULTS.ctxSize ?? 32768;
        m.ctxSize = ctx;
        m.args = [
          '--alias', m.alias,
          '--ctx-size', String(ctx),
          '--cache-type-k', String(raw.cacheTypeK ?? DEFAULTS.cacheTypeK ?? 'q8_0'),
          '--cache-type-v', String(raw.cacheTypeV ?? DEFAULTS.cacheTypeV ?? 'q4_0'),
          '--fit-target', String(raw.fitTargetMiB ?? DEFAULTS.fitTargetMiB ?? 1024),
        ];
        if (raw.mtp) m.args.push('--spec-type', 'draft-mtp', '--spec-draft-n-max', String(raw.specDraftNMax ?? 2));
      }
    }

    // Effective "fake" context ceiling: explicit > global > ratio of the model's window
    // (see the header). External servers are never policed unless the user sets it explicitly.
    if (m.softContextLimit === undefined || m.softContextLimit === null) m.softContextLimit = cfg.softContextLimit;
    if (m.softContextLimit === undefined || m.softContextLimit === null) {
      const ratio = raw.softContextRatio ?? DEFAULT_SOFT_RATIO;
      const real = m.external ? 0 : (m.ctxSize ?? parseCtxSize(m));
      m.softContextLimit = (!m.external && real > 0 && ratio > 0) ? Math.floor(real * ratio) : 0;
    }
    return m;
  });
}

cfg.models = normalizeModels(cfg.models);

// `node supervisor.js <config> --dump-models` prints the normalized model list and exits.
// Route/config generators consume this so the normalization rules live in exactly one place.
if (process.argv.includes('--dump-models')) {
  process.stdout.write(JSON.stringify({
    idleTimeoutSec: cfg.idleTimeoutSec ?? 500,
    models: cfg.models.map((m) => ({
      key: m.key,
      label: m.label,
      alias: m.alias,
      external: !!m.external,
      publicPort: m.publicPort,
      internalPort: m.internalPort ?? null,
      url: m.external ? `http://${m.targetHost}:${m.targetPort}${m.targetBase}` : null,
      ctxSize: m.ctxSize ?? (m.external ? null : parseCtxSize(m) || null),
      softContextLimit: m.softContextLimit ?? null,
    })),
  }, null, 2) + '\n');
  process.exit(0);
}

/* ------------------------------------------------------------------ state */

for (const m of cfg.models) {
  m.proc = null;          // live child, or null
  m.starting = null;      // in-flight start promise, or null
  m.lastUsed = Date.now();
  m.active = 0;           // requests currently being proxied
  m.lastError = null;
  m.softGraceUntil = 0;   // while in the future, the ceiling is not enforced
  m.stoppedIntentionally = 0;   // timestamp of the last deliberate stop (see proxyBufferedWithRetry)
  // The real window, taken from the launch args so it can never drift from what llama-server
  // was actually started with.
  m.realContextLimit = m.external ? 0 : parseCtxSize(m);
}

// The real window, taken from the launch args so it can never drift from what llama-server
// was actually started with.
function parseCtxSize(m) {
  const all = [...(COMMON.args || []), ...(m.args || [])];
  const i = all.lastIndexOf('--ctx-size');
  if (i >= 0 && all[i + 1] !== undefined) {
    const n = parseInt(all[i + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/* ------------------------------------------------------- process helpers */

function isRunning(m) {
  // An external server is not ours to manage: treat it as always available and let any real
  // connection problem surface as a 502 instead of us trying to spawn something.
  if (m.external) return true;
  return !!(m.proc && m.proc.exitCode === null && !m.proc.killed);
}

/** Where a request for this model actually goes on the wire. */
function upstreamFor(m, reqPath) {
  const p = reqPath || '/';
  if (m.external) {
    const tail = p.startsWith('/v1') ? p.slice(3) : p;
    return {
      host: m.targetHost,
      port: m.targetPort,
      path: m.targetBase + (tail.startsWith('/') ? tail : '/' + tail),
      hostHeader: `${m.targetHost}:${m.targetPort}`,
    };
  }
  return { host: '127.0.0.1', port: m.internalPort, path: p, hostHeader: `127.0.0.1:${m.internalPort}` };
}

// Ask llama-server's own /health whether it is serving. Never throws.
function probeHealth(m, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: m.internalPort, path: '/health', method: 'GET', timeout: timeoutMs, agent: false },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve(JSON.parse(body).status === 'ok'); } catch { resolve(false); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// One throwaway token, so the graphs and compute buffers exist before real traffic arrives.
function warmUp(m) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, temperature: 0,
    }));
    const req = http.request({
      host: '127.0.0.1', port: m.internalPort, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length },
      timeout: 120000,
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.on('error', () => resolve());
    req.end(payload);
  });
}

// Windows: taskkill /T /F so the whole child tree dies and VRAM is actually released.
function killTree(pid) {
  return new Promise((resolve) => {
    const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    k.on('exit', () => resolve());
    k.on('error', () => resolve());
  });
}

async function stopModel(m, reason) {
  if (m.external) { log(`[${m.key}] external model (${m.targetHost}:${m.targetPort}) — not ours to stop, leaving it alone`); return; }
  if (!isRunning(m)) { m.proc = null; return; }
  const pid = m.proc.pid;
  log(`[${m.key}] stopping (pid ${pid}, reason: ${reason})`);
  try { await killTree(pid); } catch { /* fall through to the wait below */ }

  const deadline = Date.now() + STOP_GRACE_MS * 1000;
  while (Date.now() < deadline) {
    if (!isRunning(m)) break;
    await sleep(300);
  }
  m.proc = null;
  // Remember that this was deliberate, so the retry path below does not immediately fight the
  // switch by starting this model again.
  m.stoppedIntentionally = Date.now();
  // Sockets to the process we just killed are useless now — a reused one would talk to a dead
  // server and surface as a spurious ECONNRESET.
  try { UPSTREAM_AGENT.destroy() } catch { }
  // wait until the port stops answering, so the next start cannot race the old socket
  const portDeadline = Date.now() + 5000;
  while (Date.now() < portDeadline) {
    if (!(await probeHealth(m, 800))) break;
    await sleep(300);
  }
  log(`[${m.key}] stopped`);
}

async function startModel(m) {
  if (m.external) return;                      // it is already running somewhere else
  if (isRunning(m) && (await probeHealth(m))) return;

  // Single GPU slot: another managed model has to give up the card first. But NEVER kill one that
  // is mid-request — that aborts a live generation and the client sees a broken stream
  // ("Stream ended without finish_reason"). Refuse instead and let the caller retry once the other
  // model is idle. This was a real incident: a stray request for the other model killed a
  // generation that was already streaming.
  for (const other of cfg.models) {
    if (other === m || other.external || !isRunning(other)) continue;
    if (other.active > 0) {
      throw new Error(`[${other.key}] is serving ${other.active} request(s) and holds the GPU; `
        + `refusing to kill a live generation to start [${m.key}]`);
    }
    log(`[${m.key}] needs the GPU; stopping [${other.key}] first`);
    await stopModel(other, 'switched to ' + m.key);
  }

  if (m.starting) { await m.starting; return; }

  m.starting = (async () => {
    const args = [
      '--model', m.model,
      '--port', String(m.internalPort),
      ...(COMMON.args || []),
      ...(m.args || []),
    ];
    if (!COMMON.bin) throw new Error('no llama-server binary configured — set "llamaServer.bin" (or the legacy "common.bin") in the config');
    log(`[${m.key}] starting ${COMMON.bin}`);
    const proc = spawn(COMMON.bin, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    m.proc = proc;

    const toLog = (buf) => {
      const text = buf.toString();
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        if (!CHILD_LOG_ALL) {
          // Keep warnings/errors and a few meaningful phrases, drop the routine noise
          // (load tensors, slot timings, graph reuse) that llama.cpp emits constantly —
          // it dominated both the log file and this process's allocation churn.
          const interesting = /^\d+(?:\.\d+)* [WE] /.test(t)
            || /exceed|out of memory|CUDA error|assert|abort|failed|panick/i.test(t);
          if (!interesting) continue;
        }
        log(`[${m.key}] ${t}`);
      }
    };
    proc.stdout.on('data', toLog);
    proc.stderr.on('data', toLog);
    proc.on('exit', (code) => {
      log(`[${m.key}] llama-server exited (code ${code})`);
      if (m.proc === proc) m.proc = null;
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!isRunning(m)) throw new Error('llama-server exited during startup');
      if (await probeHealth(m)) {
        log(`[${m.key}] healthy on internal port ${m.internalPort}; warming up`);
        await warmUp(m);
        if (SETTLE_MS > 0) await sleep(SETTLE_MS);
        if (!isRunning(m)) throw new Error('llama-server died during warm-up');
        log(`[${m.key}] ready on internal port ${m.internalPort} (ctx ${m.realContextLimit || '?'}, soft ceiling ${m.softContextLimit || 'off'})`);
        m.stoppedIntentionally = 0;
        return;
      }
      await sleep(1000);
    }
    throw new Error(`llama-server did not become healthy within ${START_TIMEOUT_MS / 1000}s`);
  })();

  try {
    await m.starting;
    m.lastError = null;
  } catch (err) {
    m.lastError = err.message;
    log(`[${m.key}] START FAILED: ${err.message}`);
    await stopModel(m, 'startup failure');
    throw err;
  } finally {
    m.starting = null;
  }
}

/* ---------------------------------------------------------------- proxying */

function proxyTo(m, req, res) {
  const target = upstreamFor(m, req.url);
  const headers = { ...req.headers };
  headers.host = target.hostHeader;

  const upstream = http.request(
    { host: target.host, port: target.port, method: req.method, path: target.path, headers, agent: UPSTREAM_AGENT },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);                       // stream through: SSE works untouched
    }
  );

  upstream.on('error', (err) => {
    log(`[${m.key}] upstream error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: { message: `supervisor: upstream ${m.key} failed: ${err.message}`, type: 'supervisor_upstream_error' },
      }));
    } else {
      res.end();
    }
  });

  res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
  req.pipe(upstream);
}

/* ------------------------------------------ which requests may wake a model */

// ONLY these paths may start a model. Everything else must not: a stray request to the port used
// to load a multi-GB model AND — because only one model fits on the card — kill whatever model was
// serving at that moment. That is not hypothetical: a client polling `GET /wyvrn/Synapse` (24
// times, alternating between both public ports) repeatedly swapped the resident model and cut off
// live generations mid-stream.
const INFERENCE_PATHS = new Set([
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/responses',
  '/v1/embeddings',
  '/completion',
  '/chat/completions',
  '/embeddings',
  '/embedding',
  '/reranking',
  '/infill',
]);

/* ------------------------------------------ soft context ceiling (fake overflow) */

// Paths whose prompt size we police using llama.cpp's token-counting endpoint.
const COUNTED_PATHS = new Set(['/v1/chat/completions', '/v1/responses']);
const MAX_BODY_BYTES = 16 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Exact templated prompt size, as llama-server itself would count it. Returns null when the
// answer is unavailable; the caller then fails OPEN and forwards the request, because the soft
// ceiling is an optimisation and must never break traffic on its own.
function countInputTokens(m, bodyBuf) {
  return new Promise((resolve) => {
    const target = upstreamFor(m, '/v1/chat/completions/input_tokens');
    const req = http.request({
      host: target.host, port: target.port, path: target.path, agent: UPSTREAM_AGENT,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': bodyBuf.length },
      timeout: 30000,
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          resolve(typeof j.input_tokens === 'number' ? j.input_tokens : null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end(bodyBuf);
  });
}

// Deliberately byte-for-byte the shape llama-server returns on a real overflow. pi-ai matches it
// with /exceeds the available context size/i (its OVERFLOW_PATTERNS entry is literally commented
// "llama.cpp server") and classifies it as CONTEXT_WINDOW_EXCEEDED, which is what triggers
// dsh-compaction-basic's overflow recovery.
//
// `limit` is what gets reported as n_ctx: the soft ceiling normally, or the real window when the
// request is past even that. Either wording classifies identically, so the guard stays active at
// every size.
function syntheticOverflow(m, res, n, limit = m.softContextLimit) {
  res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    error: {
      code: 400,
      message: `request (${n} tokens) exceeds the available context size (${limit} tokens), try increasing it`,
      type: 'exceed_context_size_error',
      n_prompt_tokens: n,
      n_ctx: limit,
    },
  }));
}

// Returns true when the response was fully delivered, false when the upstream failed before
// anything was committed to the client (in which case the caller may retry).
function sendBuffered(m, req, res, body) {
  return new Promise((resolve) => {
    const target = upstreamFor(m, req.url);
    const headers = { ...req.headers };
    headers.host = target.hostHeader;
    delete headers['transfer-encoding'];
    headers['content-length'] = body.length;

    const upstream = http.request(
      { host: target.host, port: target.port, method: req.method, path: target.path, headers, agent: UPSTREAM_AGENT },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
        up.on('end', () => resolve(true));
        up.on('error', () => resolve(true));   // headers already sent; nothing to retry
      }
    );

    upstream.on('error', (err) => {
      log(`[${m.key}] upstream error: ${err.message}`);
      resolve(false);
    });

    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    upstream.end(body);
  });
}

// A server that just started can die on its first large request; if that happens before we have
// committed any bytes, bring it back and replay the request once instead of failing the client.
async function proxyBufferedWithRetry(m, req, res, body, retriesLeft = 1) {
  const delivered = await sendBuffered(m, req, res, body);
  if (delivered) return;

  if (res.headersSent) { res.end(); return; }

  if (retriesLeft > 0 && !res.writableEnded && Date.now() - m.stoppedIntentionally > 10000) {
    log(`[${m.key}] retrying the request once (the server may have died on a cold first request)`);
    try { await startModel(m); } catch (err) { log(`[${m.key}] restart before retry failed: ${err.message}`); }
    if (!res.writableEnded) return proxyBufferedWithRetry(m, req, res, body, retriesLeft - 1);
    return;
  }

  if (!res.writableEnded) {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: { message: `supervisor: upstream ${m.key} failed and could not be recovered`, type: 'supervisor_upstream_error' },
    }));
  }
}

/* --------------------------------------------------- metadata short-circuits */

// These must never wake the GPU: clients poll them, and starting a 9 GB model for a
// /v1/models listing would defeat the whole point of the idle shutdown.
function syntheticMetadata(m, req, res) {
  const url = (req.url || '').split('?')[0];

  if (url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok', supervisor: true, model: m.key, modelLoaded: isRunning(m),
      idleTimeoutSec: cfg.idleTimeoutSec ?? 500,
    }));
  }

  if (url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      object: 'list',
      data: [{ id: m.alias, object: 'model', owned_by: `supervisor(${m.key})`, created: Math.floor(Date.now() / 1000) }],
    }));
  }

  res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    error: {
      message: `supervisor: ${m.key} is not loaded (idle-shutdown). ${url} is a metadata route and does not wake it; send an inference request instead.`,
      type: 'supervisor_model_unloaded',
    },
  }));
}

/* ------------------------------------------------------------ status / unload */

function statusPayload() {
  const now = Date.now();
  const mu = process.memoryUsage();
  const mb = (n) => +(n / 1048576).toFixed(1);
  return {
    object: 'supervisor.status',
    pid: process.pid,
    idleTimeoutSec: cfg.idleTimeoutSec ?? 500,
    // Resident-memory breakdown. Handy for spotting a leak, and it is what makes "the supervisor
    // is cheap" a measurement rather than a claim.
    memory: {
      rssMiB: mb(mu.rss),
      heapUsedMiB: mb(mu.heapUsed),
      heapTotalMiB: mb(mu.heapTotal),
      externalMiB: mb(mu.external),
      arrayBuffersMiB: mb(mu.arrayBuffers),
    },
    models: cfg.models.map((m) => ({
      key: m.key,
      label: m.label,
      external: !!m.external,
      url: m.external ? `http://${m.targetHost}:${m.targetPort}${m.targetBase}` : null,
      publicPort: m.publicPort,
      internalPort: m.internalPort ?? null,
      softContextLimit: m.softContextLimit || null,
      realContextLimit: m.realContextLimit || null,
      graceActive: Date.now() < m.softGraceUntil,
      running: isRunning(m),
      starting: !!m.starting,
      activeRequests: m.active,
      idleSec: m.lastUsed ? Math.round((now - m.lastUsed) / 1000) : null,
      stopInSec: !m.external && isRunning(m) && m.active === 0
        ? Math.max(0, Math.round((IDLE_MS - (now - m.lastUsed)) / 1000))
        : null,
      lastError: m.lastError,
    })),
  };
}

async function unloadAll(reason) {
  for (const m of cfg.models) {
    if (isRunning(m)) await stopModel(m, reason);
  }
}

/* --------------------------------------------------------------- listeners */

function handleSupervisorRoute(m, req, res) {
  const url = (req.url || '').split('?')[0];
  if (url === '/__supervisor/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(statusPayload(), null, 2));
    return true;
  }
  if (url === '/__supervisor/unload') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'POST required' } }));
      return true;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    unloadAll('explicit /__supervisor/unload')
      .then(() => res.end(JSON.stringify({ ok: true, status: statusPayload() })))
      .catch((e) => res.end(JSON.stringify({ ok: false, error: e.message })));
    return true;
  }
  return false;
}

for (const m of cfg.models) {
  const server = http.createServer(async (req, res) => {
    if (handleSupervisorRoute(m, req, res)) return;

    const url = (req.url || '').split('?')[0];
    const isMetadata = url === '/health' || url === '/v1/models' || url === '/props' || url === '/metrics';

    // Metadata while unloaded -> answer locally, do NOT touch the GPU.
    if (isMetadata && !isRunning(m)) { syntheticMetadata(m, req, res); return; }

    // A non-inference route must never wake a model, and above all must never trigger the
    // single-GPU-slot switch (waking one model kills whichever one is serving). If the model
    // happens to be up we still forward it; otherwise say plainly that this is not an
    // inference port. A guard against exactly the polling client described above.
    if (!isMetadata && !INFERENCE_PATHS.has(url) && !isRunning(m)) {
      const ua = req.headers['user-agent'] || '';
      log(`[${m.key}] ${req.method} ${url} is not an inference route -> 404 without waking anything (ua="${ua}")`);
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: {
          message: `supervisor: ${url} is not an inference route, so ${m.key} was left unloaded. `
            + `Inference paths are: ${[...INFERENCE_PATHS].join(', ')}`,
          type: 'supervisor_unknown_route',
        },
      }));
      return;
    }

    try {
      if (!isRunning(m)) log(`[${m.key}] request ${req.method} ${url} -> waking model`);
      await startModel(m);
    } catch (err) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: { message: `supervisor: could not start ${m.key}: ${err.message}`, type: 'supervisor_start_failed' },
      }));
      return;
    }

    m.active += 1;
    m.lastUsed = Date.now();
    res.on('close', () => {
      m.active = Math.max(0, m.active - 1);
      m.lastUsed = Date.now();           // idle countdown starts when the last request ends
    });

    // Soft context ceiling: reject above the "fake" limit so compaction runs while the real
    // window still has room for the summarization request.
    if (m.softContextLimit > 0 && req.method === 'POST' && COUNTED_PATHS.has(url)) {
      const body = await readBody(req).catch((err) => {
        log(`[${m.key}] could not buffer the request body (${err.message}); forwarding as a stream`);
        return null;
      });
      if (body !== null) {
        const n = await countInputTokens(m, body);
        if (n !== null && n > m.softContextLimit) {
          // Inside the grace window this is most likely DSH's compaction replay: let it through,
          // otherwise compaction could never complete and the session would be stuck.
          if (Date.now() < m.softGraceUntil) {
            log(`[${m.key}] GRACE: allowing ${n} tokens past the ${m.softContextLimit} ceiling (compaction replay)`);
            return proxyBufferedWithRetry(m, req, res, body);
          }
          // The ceiling applies at EVERY size, including above the real window. An earlier version
          // forwarded those "so llama-server can report the authentic error" — which silently
          // switched the guard off exactly when it mattered most: a session could sail past the real
          // window and then grow without bound, until nobody could compact it any more. Report the
          // real window in the message when we are past it, but still answer it here.
          const real = m.realContextLimit;
          const reported = (real > 0 && n > real) ? real : m.softContextLimit;
          log(`[${m.key}] SOFT LIMIT HIT: ${n} prompt tokens > ceiling ${m.softContextLimit}` +
              (reported !== m.softContextLimit ? ` (and past the real window ${real})` : '') +
              ` -> synthetic exceed_context_size_error (${reported})`);
          m.softGraceUntil = Date.now() + SOFT_GRACE_MS;
          return syntheticOverflow(m, res, n, reported);
        }
        if (n !== null) {
          m.softGraceUntil = 0;   // a request that fits means the reduction worked
          log(`[${m.key}] prompt ${n} tokens (soft ceiling ${m.softContextLimit})`);
        }
        return proxyBufferedWithRetry(m, req, res, body);
      }
    }

    proxyTo(m, req, res);
  });

  server.on('error', (err) => {
    logConsole(`[${m.key}] FATAL: cannot listen on ${m.publicPort}: ${err.message}`);
    process.exit(1);
  });

  server.listen(m.publicPort, '127.0.0.1', () => {
    if (m.external) {
      log(`[${m.key}] listening on 127.0.0.1:${m.publicPort} -> external http://${m.targetHost}:${m.targetPort}${m.targetBase} (${m.label})`);
    } else {
      log(`[${m.key}] listening on 127.0.0.1:${m.publicPort} -> internal ${m.internalPort} (${m.label})`);
    }
  });
}

/* ------------------------------------------------------------- idle reaper */

setInterval(async () => {
  const now = Date.now();
  for (const m of cfg.models) {
    if (m.external || !isRunning(m) || m.active > 0 || m.starting) continue;
    if (now - m.lastUsed >= IDLE_MS) {
      log(`[${m.key}] idle for ${Math.round((now - m.lastUsed) / 1000)}s (>= ${IDLE_MS / 1000}s) -> releasing VRAM`);
      await stopModel(m, 'idle timeout');
    }
  }
}, CHECK_MS);

/* ---------------------------------------------------------------- shutdown */

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logConsole(`received ${signal}; stopping managed models`);
  await unloadAll('supervisor shutdown');
  logConsole('supervisor exiting');
  try { LOG_STREAM.end() } catch { }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('exit', () => {
  for (const m of cfg.models) {
    if (isRunning(m)) { try { spawn('taskkill', ['/PID', String(m.proc.pid), '/T', '/F'], { windowsHide: true }); } catch {} }
  }
});

logConsole(`supervisor started (pid ${process.pid}) - idleTimeout=${IDLE_MS / 1000}s check=${CHECK_MS / 1000}s`);
logConsole(`config: ${CONFIG_PATH}`);
