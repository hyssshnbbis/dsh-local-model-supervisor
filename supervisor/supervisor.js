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

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* logging must never crash us */ }
}

/* ------------------------------------------------------------------ state */

for (const m of cfg.models) {
  m.proc = null;          // live child, or null
  m.starting = null;      // in-flight start promise, or null
  m.lastUsed = Date.now();
  m.active = 0;           // requests currently being proxied
  m.lastError = null;
  // Model id reported by the synthetic /v1/models reply. Defaults to the config key; set
  // "alias" per model when your client matches on a specific model name.
  m.alias = m.alias || m.key;
  // "Fake" context ceiling below the real --ctx-size; 0 disables the check.
  m.softContextLimit = m.softContextLimit ?? cfg.softContextLimit ?? 0;
  m.realContextLimit = parseCtxSize(m);
  m.softGraceUntil = 0;   // while in the future, the ceiling is not enforced
}

// The real window, taken from the launch args so it can never drift from what llama-server
// was actually started with.
function parseCtxSize(m) {
  const all = [...(cfg.common.args || []), ...(m.args || [])];
  const i = all.lastIndexOf('--ctx-size');
  if (i >= 0 && all[i + 1] !== undefined) {
    const n = parseInt(all[i + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

const byPublicPort = new Map(cfg.models.map((m) => [m.publicPort, m]));

/* ------------------------------------------------------- process helpers */

function isRunning(m) {
  return !!(m.proc && m.proc.exitCode === null && !m.proc.killed);
}

// Ask llama-server's own /health whether it is serving. Never throws.
function probeHealth(m, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: m.internalPort, path: '/health', method: 'GET', timeout: timeoutMs },
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
  // wait until the port stops answering, so the next start cannot race the old socket
  const portDeadline = Date.now() + 5000;
  while (Date.now() < portDeadline) {
    if (!(await probeHealth(m, 800))) break;
    await sleep(300);
  }
  log(`[${m.key}] stopped`);
}

async function startModel(m) {
  if (isRunning(m) && (await probeHealth(m))) return;

  // single GPU slot: a second 27B model cannot coexist on this card
  for (const other of cfg.models) {
    if (other !== m && isRunning(other)) {
      log(`[${m.key}] needs the GPU; stopping [${other.key}] first`);
      await stopModel(other, 'switched to ' + m.key);
    }
  }

  if (m.starting) { await m.starting; return; }

  m.starting = (async () => {
    const args = [
      '--model', m.model,
      '--port', String(m.internalPort),
      ...(cfg.common.args || []),
      ...(m.args || []),
    ];
    log(`[${m.key}] starting ${cfg.common.bin}`);
    const proc = spawn(cfg.common.bin, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    m.proc = proc;

    const toLog = (buf) => {
      const text = buf.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        // llama.cpp is very chatty at -lv 4; keep the supervisor log readable
        if (/^\d+\.\d+\.\d+\.\d+ [IWD] (load_tensors|llama_context|llama_kv_cache|sched_reserve|common_init|init:)/.test(line)) continue;
        log(`[${m.key}] ${line.trim()}`);
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
  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${m.internalPort}`;

  const upstream = http.request(
    { host: '127.0.0.1', port: m.internalPort, method: req.method, path: req.url, headers },
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

/* ------------------------------------------ soft context ceiling (fake overflow) */

// Paths whose prompt size we police using llama.cpp's token-counting endpoint.
const COUNTED_PATHS = new Set(['/v1/chat/completions', '/v1/responses']);
const MAX_BODY_BYTES = 64 * 1024 * 1024;

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
    const req = http.request({
      host: '127.0.0.1', port: m.internalPort, path: '/v1/chat/completions/input_tokens',
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
function syntheticOverflow(m, res, n) {
  res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    error: {
      code: 400,
      message: `request (${n} tokens) exceeds the available context size (${m.softContextLimit} tokens), try increasing it`,
      type: 'exceed_context_size_error',
      n_prompt_tokens: n,
      n_ctx: m.softContextLimit,
    },
  }));
}

// Returns true when the response was fully delivered, false when the upstream failed before
// anything was committed to the client (in which case the caller may retry).
function sendBuffered(m, req, res, body) {
  return new Promise((resolve) => {
    const headers = { ...req.headers };
    headers.host = `127.0.0.1:${m.internalPort}`;
    delete headers['transfer-encoding'];
    headers['content-length'] = body.length;

    const upstream = http.request(
      { host: '127.0.0.1', port: m.internalPort, method: req.method, path: req.url, headers },
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

  if (retriesLeft > 0 && !res.writableEnded) {
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
  return {
    object: 'supervisor.status',
    pid: process.pid,
    idleTimeoutSec: cfg.idleTimeoutSec ?? 500,
    models: cfg.models.map((m) => ({
      key: m.key,
      label: m.label,
      publicPort: m.publicPort,
      internalPort: m.internalPort,
      softContextLimit: m.softContextLimit || null,
      realContextLimit: m.realContextLimit || null,
      graceActive: Date.now() < m.softGraceUntil,
      running: isRunning(m),
      starting: !!m.starting,
      activeRequests: m.active,
      idleSec: m.lastUsed ? Math.round((now - m.lastUsed) / 1000) : null,
      stopInSec: isRunning(m) && m.active === 0
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
          const real = m.realContextLimit;
          // Above the real window too: let llama-server answer authentically, it says the same thing.
          if (real > 0 && n > real) {
            log(`[${m.key}] ${n} tokens exceeds the real window ${real}; forwarding for the authentic error`);
            return proxyBufferedWithRetry(m, req, res, body);
          }
          // Inside the grace window this is most likely DSH's compaction replay: let it through,
          // otherwise compaction could never complete and the session would be stuck.
          if (Date.now() < m.softGraceUntil) {
            log(`[${m.key}] GRACE: allowing ${n} tokens past the ${m.softContextLimit} ceiling (compaction replay)`);
            return proxyBufferedWithRetry(m, req, res, body);
          }
          log(`[${m.key}] SOFT LIMIT HIT: ${n} prompt tokens > ${m.softContextLimit} (real window ${real || '?'} still has room) -> synthetic exceed_context_size_error`);
          m.softGraceUntil = Date.now() + SOFT_GRACE_MS;
          return syntheticOverflow(m, res, n);
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
    log(`[${m.key}] FATAL: cannot listen on ${m.publicPort}: ${err.message}`);
    process.exit(1);
  });

  server.listen(m.publicPort, '127.0.0.1', () => {
    log(`[${m.key}] listening on 127.0.0.1:${m.publicPort} -> internal ${m.internalPort} (${m.label})`);
  });
}

/* ------------------------------------------------------------- idle reaper */

setInterval(async () => {
  const now = Date.now();
  for (const m of cfg.models) {
    if (!isRunning(m) || m.active > 0 || m.starting) continue;
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
  log(`received ${signal}; stopping managed models`);
  await unloadAll('supervisor shutdown');
  log('supervisor exiting');
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

log(`supervisor started (pid ${process.pid}) - idleTimeout=${IDLE_MS / 1000}s check=${CHECK_MS / 1000}s`);
log(`config: ${CONFIG_PATH}`);
