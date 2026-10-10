# dsh-local-model-supervisor

[中文](README.zh-CN.md) | **English**

> **Lazy-start a local llama.cpp model when DSH needs it, release RAM/VRAM when it doesn't.**
>
> **本地大模型「用到才起、不用就放」:按需冷启动 + 空闲自动释放 + 一个假的上下文上限来兜住压缩。**

> [!IMPORTANT]
> **AI-written code.** Every file in this repository was produced by an AI coding agent, not by
> hand — see **[AI-DISCLOSURE.md](AI-DISCLOSURE.md)** before you run it. It was verified on a
> single Windows machine, with no security review and no test suite.
>
> **本项目由 AI 编写。** 全部代码与文档均由 AI 编码助手产出,不是手写的 —— 运行前请先读
> **[AI-DISCLOSURE.md](AI-DISCLOSURE.md)**。仅在作者的一台 Windows 机器上验证过,无安全审计、无测试套件。

A local-model supervisor for [DeepSeek Harness](https://github.com/deepseek-ai). It occupies the
ports your DSH local routes already point at and runs `llama-server` on private internal ports:
the model is loaded on the first request and **all RAM/VRAM is given back once it goes idle**.
Ships with a DSH plugin so the whole thing starts and stops with DSH.

```
DSH ──> 127.0.0.1:8080 (supervisor, always resident: ~30 MB RAM, 0 VRAM)
              │
              ├─ first inference request ──> 127.0.0.1:9080 (llama-server, started on demand)
              └─ 500s with no requests   ──> llama-server killed, VRAM released
```

---

## 1. Why this exists

DSH's local routes go through `@deepseek-ai/dsh-llm-pi-ai`, whose config is just
`api: openai-completions` + `baseURL` — it is a plain **HTTP client**. It has no hook that could
execute `llama-server.exe`. So in practice: the model is statically configured and always visible
in the model picker, but selecting it while nothing is running just fails to connect, and
**nothing will ever start it for you**.

The decision to lazy-start has to happen *before* the request reaches llama-server, so it can only
be intercepted at the HTTP layer. This project makes the supervisor **occupy the ports DSH is
already talking to** and moves the real llama-server to internal ports — so **no DSH configuration
has to change at all**, and curl / Python / any other client gets the same behaviour for free.

## 2. Features

| Feature | Description |
|---|---|
| **One unified model list** | Declare any number of local models in a single list. Give a **`path`** and the supervisor manages the process; give a **`url`** and it just forwards to a server you already run (Ollama, LM Studio, vLLM, …). Two fields per entry is enough. |
| **Ports allocated automatically** | The *i*-th model takes `publicBase + i`; managed models take the next free port at or above `internalBase`, skipping anything claimed. Collisions are rejected at startup, never at spawn time. |
| **Routes generated for you** | `scripts/export-dsh-routes.ps1` turns the list into a ready-to-paste DSH `providers:` block, so importing a model does not mean hand-writing YAML. |
| **Cold start on demand** | The first inference request spawns llama-server, waits for health, then proxies. Clients never need to retry. |
| **Idle release** | After `idleTimeoutSec` (default 500s) with no requests the process is killed and **both RAM and VRAM are returned**. The countdown starts when the last request *ends*, so long generations are never cut off. |
| **Metadata never wakes the GPU** | `/health` and `/v1/models` are answered synthetically; `/props` and `/metrics` return 503 while unloaded. **Otherwise a client polling `/v1/models` would pin the VRAM forever.** |
| **Single GPU slot** | Requesting a different model stops the current one first (one card cannot hold two). |
| **Soft context ceiling ("fake overflow")** | A fake ceiling below the real window forces DSH to compact while redundancy still exists — see section 5. |
| **Compaction grace window** | After a rejection, requests are let through for a while, so the summarization replay cannot be blocked by the same ceiling. |
| **Cold-start protection** | A 1-token warm-up plus a settle delay, and one automatic restart-and-replay if the server still dies on its first large request. |
| **Streaming preserved** | Byte-for-byte `pipe` forwarding; SSE works untouched. |
| **DSH plugin** | Starts/stops with DSH, plus `/localmodel status \| unload \| start` from any chat. |

## 3. Quick start

### 3.1 Requirements

- **Node.js ≥ 18** (standard library only — no third-party dependencies)
- **llama.cpp**'s `llama-server` (CUDA / Vulkan / CPU all work; developed against a Windows CUDA build)
- **PowerShell 7+** (optional, only for the `.ps1` helper scripts; the supervisor itself is pure Node)

### 3.2 Configure

```bash
cp supervisor/models.example.json supervisor/models.json
```

`models` is **one unified list** that accepts both kinds of local model source. All an entry needs
is a `name` plus either `path` or `url`:

```jsonc
{
  "idleTimeoutSec": 500,                       // how long before a model is released
  "ports": { "publicBase": 8080, "internalBase": 9080 },

  "defaults": {                                // applied to every managed model
    "ctxSize": 32768,
    "cacheTypeK": "q8_0",
    "cacheTypeV": "q4_0",
    "softContextRatio": 0.75                   // softContextLimit = ctxSize * this
  },

  "llamaServer": {
    "bin": "C:\\path\\to\\llama-server.exe",
    "args": [ "--host", "127.0.0.1", "--threads", "8", "--flash-attn", "on", "--jinja", ... ]
  },

  "models": [
    { "name": "qwen-2bit", "path": "D:\\models\\Qwen-2bit.gguf" },
    { "name": "qwen-4bit", "path": "D:\\models\\Qwen-4bit.gguf", "ctxSize": 16384, "mtp": true },
    { "name": "ollama",    "url":  "http://127.0.0.1:11434/v1" },
    { "name": "lmstudio",  "url":  "http://127.0.0.1:1234/v1" }
  ]
}
```

| Entry | Behaviour |
|---|---|
| **`path`** — managed | The supervisor spawns llama-server for that file, cold-starts it on the first request and releases RAM/VRAM when idle. |
| **`url`** — external | An already-running OpenAI-compatible server (Ollama, LM Studio, vLLM, another llama.cpp). The supervisor only **forwards** to it on its own public port; it is never started or stopped, so external entries get no idle release. |

**Ports are handed out for you.** The *i*-th entry takes `publicBase + i`, and each managed entry
takes the next free port at or above `internalBase` — skipping anything already claimed, so even a
deliberately overlapping base pair (8080 / 8081) can never hand the same port to two things.
Set `publicPort` / `internalPort` on an entry to override; genuine duplicates are rejected at
startup with a clear error instead of failing later at spawn time.

**Backwards compatible.** `common` is still accepted as an alias for `llamaServer`, and the legacy
explicit schema (`publicPort` / `internalPort` / `model` / `args` per entry) keeps working unchanged.

### 3.3 Generate the DSH routes

Declaring a model is only half the job — DSH also needs a route pointing at it, and hand-writing
YAML for every model does not scale. Generate it from the same config instead:

```powershell
pwsh -File scripts/export-dsh-routes.ps1                          # print to stdout
pwsh -File scripts/export-dsh-routes.ps1 -OutFile ..\routes.yml   # or write it to a file
```

It emits a ready-to-paste `providers:` block — one route per model, pointing at that model's
supervisor public port, with `contextWindow` filled from `ctxSize`. Paste it under
`- id: llm-pi-ai` → `config:` → `providers:` in your DSH profile patch, then restart DSH.

The generator reads the config through `supervisor.js --dump-models`, so the allocation and
defaulting rules live in exactly one place and cannot drift from what the supervisor actually does.

### 3.4 Run it

```powershell
# Foreground (Ctrl+C to stop)
node supervisor/supervisor.js supervisor/models.json

# Or in the background, via the PowerShell helpers
pwsh -File scripts/start-supervisor.ps1
pwsh -File scripts/supervisor-status.ps1     # what is loaded, and when it will be released
pwsh -File scripts/unload-local-models.ps1   # release everything now (supervisor stays up)
pwsh -File scripts/stop-supervisor.ps1       # stop the supervisor itself
```

Then point your DSH local route's `baseURL` at `http://127.0.0.1:8080/v1`.

### 3.5 Install the DSH plugin (optional, recommended)

The plugin makes the supervisor start and stop with DSH and adds a `/localmodel` command:

```bash
dsh plugin --profile desktop add link:<this repo>/plugin
```

Then set **`supervisorScript` to the absolute path of your `supervisor/supervisor.js`** in the
plugin config (`plugin/cordis.patch.yml`, `config:` section). It is required — the plugin cannot
guess where you cloned the repo.

**A DSH restart is required for the plugin to load.** After the restart you will see an `apply()`
line in the plugin log.

## 4. Configuration reference

### Supervisor (`supervisor/models.json`)

| Field | Default | Description |
|---|---|---|
| `idleTimeoutSec` | `500` | Idle time before the model process is killed |
| `checkIntervalSec` | `5` | How often the reaper checks |
| `startTimeoutSec` | `300` | Cold-start wait limit |
| `stopGraceSec` | `20` | Wait limit when stopping a process |
| `softGraceSec` | `180` | Compaction grace window after a soft-ceiling rejection (section 5) |
| `startSettleSec` | `1.5` | Settle delay after the warm-up request |
| `models[].name` / `key` | — | Identifier for the entry (also the default alias) |
| `models[].path` | — | **Managed**: the `.gguf` file to serve |
| `models[].url` | — | **External**: an already-running OpenAI-compatible base URL (e.g. `http://127.0.0.1:11434/v1`) |
| `models[].publicPort` | `publicBase + i` | Port clients connect to (owned by the supervisor) |
| `models[].internalPort` | next free ≥ `internalBase` | Port llama-server listens on (managed entries only) |
| `models[].alias` | `key` (or `--alias`) | Model id reported by `/v1/models` |
| `models[].ctxSize` | `defaults.ctxSize` | Context window for managed entries |
| `models[].cacheTypeK` / `cacheTypeV` | `defaults.*` | KV cache quantisation |
| `models[].mtp` | off | Add `--spec-type draft-mtp` (only pays off if the model has a NextN head) |
| `models[].softContextLimit` | `ctxSize × softContextRatio` | Fake context ceiling; `0` disables |
| `models[].args` | auto-built | Advanced/legacy escape hatch: pass these to llama-server verbatim instead |
| `ports.publicBase` / `ports.internalBase` | `8080` / `9080` | Automatic port allocation bases |
| `defaults.*` | see example | Field defaults for managed entries |
| `llamaServer.bin` / `.args` | — | How to launch llama-server (`common` is a legacy alias) |

### Control endpoints (on every public port)

| Endpoint | Purpose |
|---|---|
| `GET  /__supervisor/status` | JSON: per-model loaded state, idle seconds, time to release, context limits |
| `POST /__supervisor/unload` | Stop every loaded model immediately |

### Plugin config

| Field | Default | Description |
|---|---|---|
| `supervisorScript` | **required** | Absolute path to `supervisor/supervisor.js` |
| `supervisorConfig` | sibling `models.json` | Supervisor config path |
| `logFile` | `~/.dsh/local-model-supervisor.log` | Plugin log |
| `publicPorts` | `[8080]` | Ports probed to adopt an existing supervisor |
| `autoStart` | `true` | Start the supervisor with DSH |
| `unloadOnExit` | `true` | Release loaded models when DSH exits |
| `stopOnExit` | `false` | Also stop the supervisor process on exit |
| `startTimeoutMs` | `60000` | How long to wait for the supervisor to become ready |

### Chat commands

| Command | Purpose |
|---|---|
| `/localmodel` / `/localmodel status` | Show supervisor and per-model status |
| `/localmodel unload` | Release RAM/VRAM immediately |
| `/localmodel start` | Make sure the supervisor is running |

## 5. How the soft context ceiling ("fake overflow") works

**The problem.** Your local route declares a 32k window, while `dsh-compaction-basic`'s default
headroom is `headroomTokens = 65536` — **larger than the whole window**, so `W−O−B` goes negative.
That route therefore **cannot resolve a trigger threshold and proactive compaction never runs**;
the session just grows to the hard limit. Worse, when it gets there, compaction has to **replay
"system prompt + old history" to write the summary**, and that replay request may itself exceed
the window — so compaction fails.

**The fix.** The supervisor enforces a **fake ceiling below the real window**:

```
real window  32768  ────────────────────────────────┐
fake ceiling 24576  ──────────────┐                 │  ← 8192 tokens of redundancy for compaction
                                  ↓
                    reply with llama.cpp's own overflow error
                                  ↓
         DSH classifies it as CONTEXT_WINDOW_EXCEEDED -> overflow recovery
              (that path bypasses the threshold policy, reduces the oldest
               balanced range, and retries)
```

Three things make this work:

1. **Exact counting.** Before forwarding, the supervisor calls llama.cpp's
   `POST /v1/chat/completions/input_tokens` (~35 ms, and it **still reports the true token count
   even when the request already exceeds n_ctx**). If counting fails the request is forwarded —
   a safety net must never block legitimate traffic on its own.
2. **Byte-identical error.** pi-ai's `OVERFLOW_PATTERNS` has a dedicated entry
   `/exceeds the available context size/i` (commented `llama.cpp server`), so reproducing the
   native payload verbatim is guaranteed to be recognised.
3. **Compaction grace window.** The summarization request replays "system prompt + masked range",
   which — when a single turn added a lot of history — **can still exceed the fake ceiling**.
   So after a rejection the ceiling is relaxed for `softGraceSec`, letting that replay through.
   Without it the summary request would be blocked by our own ceiling and the session would deadlock.

> The fake ceiling must stay **above** DSH's own proactive-compaction trigger, or it would also
> block the summarization replay.

## 6. Measured results

Test machine: RTX 4070 Ti 12 GB · Ryzen 5 9600X · 31 GB RAM · Windows · llama.cpp CUDA build.

| Scenario | Result |
|---|---|
| Supervisor idle | ~30 MB RAM, **0 VRAM** |
| Cold start, 9.15 GB 2-bit model | **5.7 – 8.8 s** including load, correct answer |
| Cold start, 13.26 GB 4-bit model | **13.6 s** |
| Idle release (4-bit loaded) | **9,686 MiB** of VRAM returned |
| Request after a full release | **7.6 s** to start again |
| `/health`, `/v1/models`, `/props` | model **not** woken, VRAM unchanged |
| 26,012-token request (fake ceiling 24,576 / real 32,768) | **HTTP 400**, byte-identical to the native overflow |
| Same request straight to the internal port (bypassing the supervisor) | **HTTP 200** — proving the 8k redundancy is real |
| Same request immediately after a rejection (simulating the compaction replay) | **HTTP 200** (grace window) |
| A small request afterwards | grace cleared; the next oversized request triggers again |
| Cold start + a 26k request | **llama-server crashed** before the warm-up fix; stable **200** after |

## 7. Notes and limitations

- **Supervisor mode is exclusive with running llama-server yourself** (both want the same public
  port). `scripts/start-supervisor.ps1` stops an existing llama-server first.
- **The fake ceiling depends on DSH's error classification**, which lives in pi-ai (see section 5),
  not in this project. If upstream ever changes the wording, the fake ceiling silently degrades to
  "as if it were not there". The native `compaction-basic` + `modelPolicies` approach remains the
  correct fix then — and **the two can be used together** without conflict.
- **Single GPU slot**: only one model runs at a time; asking for another stops the current one
  (and pays its cold start).
- The supervisor takes no VRAM, but it is necessarily **excluded from the idle reaper** — it has to
  stay resident to be able to start anything on demand.
- It listens on `127.0.0.1` only and has no authentication. Put a reverse proxy and auth in front
  of it if you expose it to a network.

## 8. Directory structure

```
.
├─ AI-DISCLOSURE.md             AI authorship notice — please read this first
├─ supervisor/
│   ├─ supervisor.js            the supervisor itself (Node, zero dependencies)
│   └─ models.example.json      config template -> copy to models.json
├─ plugin/
│   ├─ package.json             DSH plugin package (dsh.bundle.patch -> the yml below)
│   ├─ cordis.patch.yml         mount declaration + config (supervisorScript required)
│   └─ lib/index.js             plugin: lifecycle + /localmodel command
├─ scripts/                     optional PowerShell helpers
│   ├─ start-supervisor.ps1     start the supervisor
│   ├─ stop-supervisor.ps1      stop the supervisor
│   ├─ supervisor-status.ps1    status
│   ├─ unload-local-models.ps1  release everything now
│   ├─ export-dsh-routes.ps1   generate the DSH `providers:` block from models.json
│   ├─ install-autostart.ps1    start at logon (scheduled task; unnecessary once the plugin is used)
│   └─ uninstall-autostart.ps1  remove it
└─ LICENSE
```

## 9. DSH plugin implementation notes

**It runs DSH's own Electron binary as Node.** DSH runs inside Electron, so `process.execPath` is
the application binary, not node. The plugin starts the supervisor with
`ELECTRON_RUN_AS_NODE=1`, which runs that binary as a plain Node process — so **no separate Node
installation is required**, and no external path is assumed:

```js
spawn(process.execPath, [supervisorScript, config], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  windowsHide: true, stdio: ['ignore', logFd, logFd],
})
```

**Probe before spawning, and never drag DSH down.** On startup it asks `/__supervisor/status`
first and adopts an existing supervisor instead of spawning a second one; a supervisor that fails
to start, a command that fails to register, or a log file that cannot be written all just produce
a log line — they never fail DSH startup.

## License

MIT
