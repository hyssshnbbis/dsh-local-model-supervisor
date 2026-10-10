# dsh-local-model-supervisor

**中文** | [English](README.md)

> **本地大模型「用到才起、不用就放」:按需冷启动 + 空闲自动释放 + 一个假的上下文上限来兜住压缩。**
>
> **Lazy-start a local llama.cpp model when DSH needs it, release RAM/VRAM when it doesn't.**

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的本地大模型管家。它占住你 DSH 本地路由
已经在连的端口,自己把 `llama-server` 跑在内部端口上 —— **第一次请求才加载模型,闲置一段时间就把
内存和显存全部还回去**。附带一个 DSH 插件,让这套东西跟着 DSH 一起启停。

A local-model supervisor for [DeepSeek Harness](https://github.com/deepseek-ai). It occupies the
ports your DSH local routes already point at and runs `llama-server` on private internal ports:
the model is loaded on the first request and **all RAM/VRAM is given back once it goes idle**.
Ships with a DSH plugin so the whole thing starts and stops with DSH.

```
DSH ──> 127.0.0.1:8080 (supervisor, 常驻，约 30 MB 内存、0 显存)
              │
              └─ 第一次推理请求 ──> 127.0.0.1:9080 (llama-server, 按需拉起)
                 空闲 500 秒    ──> 杀掉 llama-server，显存归还
```

---

## 1. 为什么需要它

DSH 的本地路由走 `@deepseek-ai/dsh-llm-pi-ai`,配置里只有 `api: openai-completions` + `baseURL` ——
它就是个 **HTTP 客户端**,没有任何钩子能去执行 `llama-server.exe`。所以「模型是静态配置的、选择器里
永远看得见,但没跑的时候选中它只会连接失败」,而且**不会有任何东西替你把它拉起来**。

懒启动的判断必须发生在请求**到达 llama-server 之前**,所以只能在 HTTP 层拦。本项目的做法是让管家
**占住 DSH 已经在连的端口**,把真正的 llama-server 挪到内部端口 —— 于是 **DSH 侧一行配置都不用改**,
而且 curl / Python / 任何客户端都自动享受同样的行为。

## 2. 功能

| 功能 | 说明 |
|---|---|
| **按需冷启动** | 第一次推理请求时拉起 llama-server,等它健康后转发;客户端无需重试 |
| **空闲自动释放** | 无请求达 `idleTimeoutSec`(默认 500s)就杀掉进程,**内存和显存一起归还**。计时从最后一个请求结束开始,长生成不会被腰斩 |
| **元数据请求不唤醒** | `/health`、`/v1/models` 由管家直接合成应答;`/props`、`/metrics` 未加载时返回 503。**否则一个轮询的客户端就能让显存永远不释放** |
| **单卡串行** | 请求另一个模型时先停掉当前模型再拉起目标模型(一张卡装不下两个) |
| **软上下文上限(假溢出)** | 见第 5 节 —— 用一个低于真实窗口的「假上限」逼 DSH 在还有冗余时压缩 |
| **压缩宽限期** | 拦下之后开一个时间窗,避免把压缩摘要请求自己拦死 |
| **冷启动保护** | 启动后先发一个 1 token 预热请求 + 沉降等待,失败还能自动重启重放一次 |
| **流式无损** | 逐字节 pipe 转发,SSE 不受影响 |
| **DSH 插件** | 跟随 DSH 启停,`/localmodel status \| unload \| start` 在聊天里直接管 |

## 3. 快速开始

### 3.1 依赖

- **Node.js ≥ 18**(只用标准库,无第三方依赖)
- **llama.cpp** 的 `llama-server`(CUDA / Vulkan / CPU 均可,本机用的是 Windows CUDA 构建)
- **PowerShell 7+**(可选,只为那几个 `.ps1` 辅助脚本;管家本身是纯 Node)

### 3.2 配置

```bash
cp supervisor/models.example.json supervisor/models.json
```

编辑 `supervisor/models.json`,最关键的几项:

```jsonc
{
  "idleTimeoutSec": 500,          // 多久不用就释放
  "common": {
    "bin": "C:\\path\\to\\llama-server.exe",
    "args": [ "--alias", "local-model", "--host", "127.0.0.1", "--threads", "8", ... ]
  },
  "models": [
    {
      "key": "model-a",
      "publicPort": 8080,          // DSH 路由指向这里（管家占用）
      "internalPort": 9080,        // 管家自己拉起 llama-server 用的端口（别和别人撞）
      "softContextLimit": 24576,   // 假上限，见第 5 节；0 = 关闭
      "model": "C:\\path\\to\\models\\model-a.gguf",
      "args": ["--ctx-size", "32768", "--cache-type-k", "q8_0", "--cache-type-v", "q4_0"]
    }
  ]
}
```

### 3.3 跑起来

```powershell
# 前台（Ctrl+C 停止）
node supervisor/supervisor.js supervisor/models.json

# 或后台（PowerShell 辅助脚本）
pwsh -File scripts/start-supervisor.ps1
pwsh -File scripts/supervisor-status.ps1     # 现在加载了什么、还有多久释放
pwsh -File scripts/unload-local-models.ps1   # 立刻释放显存（管家继续待命）
pwsh -File scripts/stop-supervisor.ps1       # 停掉管家
```

然后把 DSH 的本地路由 `baseURL` 指向 `http://127.0.0.1:8080/v1` 即可。

### 3.4 装 DSH 插件(可选,但推荐)

插件让管家跟着 DSH 一起启停,并加一个 `/localmodel` 命令:

```bash
dsh plugin --profile desktop add link:<本仓库>/plugin
```

然后在插件配置(`plugin/cordis.patch.yml` 的 `config:`)里把 **`supervisorScript` 指向你自己的
`supervisor/supervisor.js` 绝对路径**(这是必填项,插件没法猜你在哪克隆的)。

**必须重启 DSH 才会加载。** 重启后日志里会出现 `apply()` 那一行。

## 4. 配置参考

### 管家(`supervisor/models.json`)

| 字段 | 默认 | 说明 |
|---|---|---|
| `idleTimeoutSec` | `500` | 空闲多久后杀掉模型进程 |
| `checkIntervalSec` | `5` | 回收检查间隔 |
| `startTimeoutSec` | `300` | 冷启动等待上限 |
| `stopGraceSec` | `20` | 停止进程的等待上限 |
| `softGraceSec` | `180` | 软上限拦下后的压缩宽限期(见第 5 节) |
| `startSettleSec` | `1.5` | 启动预热后的沉降等待 |
| `models[].publicPort` | — | 客户端连接的端口(管家占用) |
| `models[].internalPort` | — | llama-server 实际监听的端口 |
| `models[].softContextLimit` | `0` | 假上下文上限,`0` = 关闭 |
| `models[].model` / `args` | — | 权重路径与追加参数 |

### 控制端点(每个公开端口上都有)

| 端点 | 作用 |
|---|---|
| `GET  /__supervisor/status` | JSON:每个模型是否加载、空闲秒数、还有多久释放、上下文上限 |
| `POST /__supervisor/unload` | 立刻停掉所有已加载模型 |

### 插件配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `supervisorScript` | **必填** | `supervisor/supervisor.js` 的绝对路径 |
| `supervisorConfig` | 同级 `models.json` | 管家配置路径 |
| `logFile` | `~/.dsh/local-model-supervisor.log` | 插件日志 |
| `publicPorts` | `[8080]` | 用于探测/接管管家的端口 |
| `autoStart` | `true` | DSH 启动时拉起管家 |
| `unloadOnExit` | `true` | DSH 退出时卸掉模型(立刻归还显存) |
| `stopOnExit` | `false` | DSH 退出时是否连管家一起停 |
| `startTimeoutMs` | `60000` | 等管家就绪的上限 |

### 聊天命令

| 命令 | 作用 |
|---|---|
| `/localmodel` / `/localmodel status` | 查看管家与各模型状态 |
| `/localmodel unload` | 立刻释放内存与显存 |
| `/localmodel start` | 确保管家在跑 |

## 5. 软上下文上限(「假溢出」)是怎么工作的

**问题。** 本地路由的窗口是 32k,而 `dsh-compaction-basic` 的默认余量 `headroomTokens = 65536`
**比整个窗口还大**,`W−O−B` 为负 —— 于是这条路由**算不出触发阈值,主动压缩永远不会发生**,
会话一路顶到硬上限。更糟的是:真到硬上限时,压缩要**重放「系统提示词 + 旧历史」去写摘要**,
这个重放请求自己也可能超窗口 → 压缩失败。

**做法。** 管家给请求加一个**低于真实窗口的假上限**:

```
真实窗口 32768  ─────────────────────────────────┐
假上限   24576  ──────────────┐                  │  ← 8192 冗余，留给压缩
                              ↓
                    返回 llama.cpp 同款的溢出错误
                              ↓
              DSH 归类 CONTEXT_WINDOW_EXCEEDED，走溢出恢复
                    （该路径绕过阈值策略，做一次最大平衡头部缩减后重试）
```

三个关键点:

1. **精确计数**:转发前调用 llama.cpp 的 `POST /v1/chat/completions/input_tokens`
   (约 35 ms,**即使已超 n_ctx 也能算出真实 token 数**)。计数失败则**放行** —— 保险装置不能自己拦死正常流量。
2. **报文逐字节同形**:pi-ai 的 `OVERFLOW_PATTERNS` 里专门有一条 `/exceeds the available context size/i`
   (注释就写着 `llama.cpp server`),所以复刻原生报文必然被识别。
3. **压缩宽限期**:摘要请求是「系统提示词 + 被遮蔽区间」,当某一轮突然塞进大量内容时它**仍可能超过假上限**。
   所以拦下一次后开 `softGraceSec` 宽限,让紧随其后的回放请求放行 —— 否则摘要请求会被自己人拦掉,会话卡死。

> 假上限必须**高于** DSH 自己的主动压缩触发点,否则会连带把摘要回放拦掉。

## 6. 实测数据

本机环境:RTX 4070 Ti 12 GB · Ryzen 5 9600X · 31 GB RAM · Windows · llama.cpp CUDA 构建。

| 场景 | 结果 |
|---|---|
| 管家空载 | 约 30 MB 内存,**0 显存** |
| 冷启动 9.15 GB 的 2-bit 模型 | **5.7 ~ 8.8 s**(含加载),回答正确 |
| 冷启动 13.26 GB 的 4-bit 模型 | **13.6 s** |
| 空闲释放(4-bit 已加载) | **归还 9686 MiB** 显存 |
| 释放后再次请求 | **7.6 s** 重新拉起 |
| `/health`、`/v1/models`、`/props` | **均未唤醒模型**,显存不变 |
| 26012 token 请求(假上限 24576 / 真实 32768) | **HTTP 400**,报文与原生溢出逐字节同形 |
| 同一请求直打内部端口(绕过管家) | **HTTP 200** —— 证明那 8k 冗余真实存在 |
| 拦下后紧接着同一请求(模拟压缩回放) | **HTTP 200**(宽限期放行) |
| 小请求通过后 | 宽限期清零,下次超限重新触发假溢出 |
| 冷启动 + 26k 大请求 | 加预热前会 **llama-server 崩溃**;加预热后稳定 **200** |

## 7. 说明与局限

- **管家模式和你自己手动跑 llama-server 是互斥的**(都要占同一个公开端口)。
  `scripts/start-supervisor.ps1` 会先停掉已有的 llama-server。
- **假上限这条路依赖 DSH 侧的错误分类**。分类规则在 pi-ai 源码里(见第 5 节),不是我们的代码;
  如果上游改了措辞,假溢出会静默失效(退回成"和没有它一样")。真到那时,原生的
  `compaction-basic` + `modelPolicies` 方案仍是正解 —— **两者可以一起上**,互不冲突。
- **单卡串行**:同一时刻只有一个模型在跑,请求另一个会先停掉当前的(冷启动要等)。
- 管家进程不占显存,但**会被空闲回收逻辑排除在外** —— 它必须常驻才能「按需拉起」。
- 只监听 `127.0.0.1`,没有鉴权。要暴露到网络请自行加反向代理和鉴权。

## 8. 目录结构

```
.
├─ supervisor/
│   ├─ supervisor.js            管家本体（Node，零依赖）
│   └─ models.example.json      配置模板 → 复制成 models.json
├─ plugin/
│   ├─ package.json             DSH 插件包（dsh.bundle.patch 指向下面那个 yml）
│   ├─ cordis.patch.yml         挂载声明 + config（supervisorScript 必填）
│   └─ lib/index.js             插件：跟随 DSH 启停 + /localmodel 命令
├─ scripts/                     PowerShell 辅助脚本（可选）
│   ├─ start-supervisor.ps1     启动管家
│   ├─ stop-supervisor.ps1      停掉管家
│   ├─ supervisor-status.ps1    状态
│   ├─ unload-local-models.ps1  立刻释放
│   ├─ install-autostart.ps1    登录自动启动（计划任务，装插件后可省）
│   └─ uninstall-autostart.ps1  取消
└─ LICENSE
```

## 9. DSH 插件的实现要点

**用 DSH 自己的 Electron 二进制当 node 用。** DSH 跑在 Electron 里,`process.execPath` 是应用本体
而不是 node。插件用 `ELECTRON_RUN_AS_NODE=1` 把它当纯 Node 进程来启动管家,所以**机器上不需要
另外装 node**,也不依赖任何外部路径:

```js
spawn(process.execPath, [supervisorScript, config], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  windowsHide: true, stdio: ['ignore', logFd, logFd],
})
```

**先探测再接管,且绝不拖垮 DSH。** 启动时先问 `/__supervisor/status`,有响应就复用、没有才拉起;
管家起不来、命令注册失败、日志写不进去,全都只记一条日志,不会让 DSH 启动失败。

## License

MIT
