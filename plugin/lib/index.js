/**
 * dsh-local-model-supervisor — a DSH plugin that owns the local llama.cpp model supervisor.
 *
 * WHAT IT DOES
 *   Makes "cold-start the local model when something needs it, release RAM/VRAM when idle"
 *   part of DSH itself instead of something you have to remember to launch:
 *
 *     - when DSH starts, it adopts a running supervisor or spawns one
 *     - when DSH exits, it unloads whatever model is resident (VRAM is returned immediately)
 *     - `/localmodel status|unload|start` in any chat drives it from inside DSH
 *
 * WHY IT WRAPS A SUPERVISOR INSTEAD OF BEING AN LLM ADAPTER
 *   The lazy-start decision has to happen *before* the request reaches llama-server. DSH's local
 *   routes run through @deepseek-ai/dsh-llm-pi-ai, which cannot start a process; the only native
 *   alternative would be to reimplement a full LlmAdapter (the pi-ai one is ~2600 lines, with
 *   images, credentials, retry policy, replay metadata and a chunk vocabulary). The supervisor
 *   already does the job, is client-agnostic, and leaves the request path untouched, so this
 *   plugin owns its lifecycle and adds a DSH-side control surface on top.
 *
 * INSTALL
 *   dsh plugin --profile <profile> add link:<path to this repo>/plugin
 *   then set supervisorScript in the plugin config (cordis.patch.yml)
 *   (a DSH restart is required for the plugin to load)
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const DEFAULTS = {
  // REQUIRED: absolute path to supervisor.js from this repository's `supervisor/` directory.
  // Set it in cordis.patch.yml (see the repo README) — there is no way to guess it, because the
  // plugin is installed under the DSH profile while the supervisor lives wherever you cloned it.
  supervisorScript: '',
  supervisorConfig: '',          // '' = <supervisor dir>/models.json
  logFile: path.join(os.homedir(), '.dsh', 'local-model-supervisor.log'),
  publicPorts: [],               // [] = derive from the supervisor config (works for any number of models)
  autoStart: true,
  unloadOnExit: true,
  stopOnExit: false,
  startTimeoutMs: 60000,
}

/* ------------------------------------------------------------------ helpers */

function makeLogger(logFile) {
  let fd = null
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fd = fs.openSync(logFile, 'a')
  } catch { /* logging is never allowed to break the plugin */ }
  return (msg) => {
    const line = `${new Date().toISOString()} [local-model-supervisor] ${msg}`
    try { console.log(line) } catch { }
    if (fd !== null) { try { fs.writeSync(fd, line + '\n') } catch { } }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** One HTTP call returning parsed JSON, or null on any failure. Never throws. */
function httpJson(url, { method = 'GET', timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let req
    try {
      req = http.request(url, { method, timeout: timeoutMs }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          try { resolve(JSON.parse(body)) } catch { resolve(null) }
        })
      })
    } catch { resolve(null); return }
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.on('error', () => resolve(null))
    req.end()
  })
}

/** Compact human-readable status block for the chat command. */
function renderStatus(supervisor) {
  const models = Array.isArray(supervisor?.models) ? supervisor.models : []
  const lines = [
    `supervisor pid ${supervisor.pid} — idle timeout ${supervisor.idleTimeoutSec}s`,
  ]
  for (const m of models) {
    const state = m.starting ? 'STARTING' : m.running ? 'LOADED' : 'unloaded'
    const bits = [`${m.key}: ${state}`, `public ${m.publicPort} -> internal ${m.internalPort}`]
    bits.push(`ctx real ${m.realContextLimit ?? '?'} / soft ${m.softContextLimit ?? 'off'}`)
    if (m.running) bits.push(`idle ${m.idleSec}s, auto-release in ${m.stopInSec}s`)
    if (m.graceActive) bits.push('compaction grace ACTIVE')
    if (m.lastError) bits.push(`lastError: ${m.lastError}`)
    lines.push('  ' + bits.join(' | '))
  }
  return lines.join('\n')
}

/* -------------------------------------------------------------------- apply */

export default {
  name: 'local-model-supervisor',

  apply(root, config) {
    const cfg = { ...DEFAULTS, ...(config || root?.config || {}) }
    const log = makeLogger(cfg.logFile)

    /**
     * Which ports to probe for an already-running supervisor.
     *
     * An explicit list wins. Otherwise it is derived from the supervisor config, so the plugin
     * keeps working no matter how many models are declared or which publicBase they start at —
     * a hardcoded `[8080]` would silently miss the supervisor (and spawn a duplicate) as soon as
     * the user has three models or moved the port base.
     *
     * This mirrors pass 1 of the supervisor's own allocation: `publicPort`, else `publicBase + i`.
     */
    function resolvePorts() {
      if (Array.isArray(cfg.publicPorts) && cfg.publicPorts.length) return cfg.publicPorts
      if (typeof cfg.publicPorts === 'number') return [cfg.publicPorts]
      try {
        const cfgPath = cfg.supervisorConfig
          || path.join(path.dirname(cfg.supervisorScript || '.'), 'models.json')
        const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
        const base = raw?.ports?.publicBase ?? 8080
        const list = (raw?.models || []).map((m, i) => m.publicPort ?? (base + i))
        if (list.length) {
          log(`derived ${list.length} public port(s) from ${cfgPath}: ${list.join(', ')}`)
          return list
        }
      } catch (err) {
        log(`could not derive public ports from the supervisor config (${err.message})`)
      }
      return [8080]
    }

    const ports = resolvePorts()

    let child = null          // the supervisor we spawned, if any
    let disposed = false

    log(`apply() — script=${cfg.supervisorScript} ports=${ports.join(',')} autoStart=${cfg.autoStart}`)

    /** Find a supervisor on any of the public ports. */
    async function findSupervisor() {
      for (const port of ports) {
        const status = await httpJson(`http://127.0.0.1:${port}/__supervisor/status`)
        if (status && typeof status === 'object' && 'models' in status) return { port, status }
      }
      return null
    }

    /** Adopt a running supervisor, or start one. Never throws. */
    async function ensureStarted(reason) {
      const running = await findSupervisor()
      if (running) {
        log(`supervisor already running (pid ${running.status.pid}) on port ${running.port} — adopting (${reason})`)
        return running
      }
      if (!cfg.autoStart) {
        log(`no supervisor running and autoStart is off (${reason})`)
        return null
      }
      if (!cfg.supervisorScript) {
        log('ERROR: supervisorScript is not configured. Set it under the plugin config in cordis.patch.yml (see the repo README).')
        return null
      }
      if (!fs.existsSync(cfg.supervisorScript)) {
        log(`ERROR: supervisor script not found at ${cfg.supervisorScript}`)
        return null
      }

      const args = [cfg.supervisorScript]
      if (cfg.supervisorConfig) args.push(cfg.supervisorConfig)

      // DSH runs inside Electron, so process.execPath is the app binary, not node. Running it
      // with ELECTRON_RUN_AS_NODE=1 executes it as a plain Node process — no external node needed.
      try {
        let stdio = 'ignore'
        try {
          const fd = fs.openSync(cfg.logFile, 'a')
          stdio = ['ignore', fd, fd]
        } catch { }
        child = spawn(process.execPath, args, {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
          detached: false,
          stdio,
        })
        child.on('exit', (code, signal) => {
          log(`supervisor process exited (code ${code}, signal ${signal})`)
          child = null
        })
        child.on('error', (err) => log(`supervisor spawn error: ${err.message}`))
        log(`spawned supervisor (${reason}) pid=${child.pid}`)
      } catch (err) {
        log(`could not spawn the supervisor: ${err.message}`)
        return null
      }

      const deadline = Date.now() + cfg.startTimeoutMs
      while (Date.now() < deadline && !disposed) {
        await sleep(500)
        const r = await findSupervisor()
        if (r) { log(`supervisor ready on port ${r.port}`); return r }
        if (!child) { log('supervisor process is gone before it became ready'); return null }
      }
      log(`supervisor did not answer within ${cfg.startTimeoutMs} ms`)
      return null
    }

    /** Ask the supervisor to release every loaded model (VRAM comes back immediately). */
    async function unloadAll(reason) {
      for (const port of ports) {
        const r = await httpJson(`http://127.0.0.1:${port}/__supervisor/unload`, { method: 'POST', timeoutMs: 60000 })
        if (r && r.ok) { log(`unloaded all models via port ${port} (${reason})`); return true }
      }
      log(`no supervisor answered unload (${reason})`)
      return false
    }

    // ---- lifecycle: start with DSH, release when DSH goes away --------------------
    ensureStarted('DSH startup').catch((err) => log(`startup hook failed: ${err.message}`))

    root.effect(() => () => {
      disposed = true
      log('DSH is shutting down')
      const done = async () => {
        if (cfg.unloadOnExit) await unloadAll('DSH shutdown')
        if (cfg.stopOnExit && child) {
          try { child.kill() ; log('stopped the supervisor we spawned') } catch (err) { log(`kill failed: ${err.message}`) }
        }
      }
      done().catch(() => { })
    })

    // ---- /localmodel command ------------------------------------------------------
    // Registered defensively: if the commands seam is unavailable or its payload shape differs,
    // the lifecycle behaviour above still works.
    try {
      root.inject(['commands'], (ctx) => {
        try {
          ctx.effect(function* () {
            yield ctx.commands.register({
              definitionId: 'dsh-local-model-supervisor/localmodel',
              name: 'localmodel',
              description: 'Manage the local llama.cpp models: status | unload | start',
              handler: async (invocation) => {
                const arg = String(invocation?.rawInput || '').trim().toLowerCase()
                try {
                  if (arg === '' || arg === 'status') {
                    const r = await findSupervisor()
                    if (!r) return { kind: 'error', text: 'local model supervisor is not running. Try `/localmodel start`.' }
                    return { kind: 'success', text: renderStatus(r.status) }
                  }
                  if (arg === 'unload' || arg === 'stop') {
                    const ok = await unloadAll('command /localmodel unload')
                    return ok
                      ? { kind: 'success', text: 'All local models unloaded; RAM/VRAM released. The next request starts one again.' }
                      : { kind: 'error', text: 'No supervisor answered the unload request.' }
                  }
                  if (arg === 'start') {
                    const r = await ensureStarted('command /localmodel start')
                    return r
                      ? { kind: 'success', text: renderStatus(r.status) }
                      : { kind: 'error', text: 'Could not start the local model supervisor; see the plugin log.' }
                  }
                  return { kind: 'error', text: 'Usage: /localmodel [status|unload|start]' }
                } catch (err) {
                  return { kind: 'error', text: `local model command failed: ${err.message}` }
                }
              },
            })
          }, 'local-model command lifecycle')
          log('registered the /localmodel command')
        } catch (err) {
          log(`could not register the /localmodel command: ${err.message}`)
        }
      })
    } catch (err) {
      log(`commands injection unavailable: ${err.message}`)
    }
  },
}
