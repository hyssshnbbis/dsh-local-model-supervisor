# dsh-local-model-supervisor

**中文** | [English](README.md)

> **本地大模型「用到才起、不用就放」:按需冷启动 + 空闲自动释放 + 一个假的上下文上限来兜住压缩。**
>
> **Lazy-start a local llama.cpp model when DSH needs it, release RAM/VRAM when it doesn't.**

> [!IMPORTANT]
> **本项目由 AI 编写。** 仓库里的全部代码与文档均由 AI 编码助手产出,不是手写的 ——
> 运行前请先读 **[AI-DISCLOSURE.md](AI-DISCLOSURE.md)**。仅在作者的一台 Windows 机器上验证过,
> 无安全审计、无测试套件。
>
> **AI-written code.** Every file in this repository was produced by an AI coding agent, not by
> hand — see **[AI-DISCLOSURE.md](AI-DISCLOSURE.md)** before you run it.

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
| **常驻开销极小** | 常驻的管家只有一个 Node 进程,比同机上的裸 `node.exe` **只多约 2~4 MB**(实测:裸 node 36.9 MB,管家 ~38~41 MB RSS;JS 堆约 6 MB)。而且**在请求到来之前完全不占显存**。它自己的内存明细就在 `GET /__supervisor/status` 的 `memory` 字段里 |
| **一份统一清单** | 任意多个本地模型写在一个列表里。给 **`path`** 就由管家托管进程;给 **`url`** 就只转发到你已经在跑的服务(Ollama / LM Studio / vLLM…)。每项两个字段就够 |
| **端口自动分配** | 第 *i* 个模型占 `publicBase + i`;托管模型从 `internalBase` 往上取第一个空闲端口,已占用的自动跳过。冲突在**启动时**就报错,不会拖到拉起进程才失败 |
| **路由自动生成** | `scripts/export-dsh-routes.ps1` 把清单变成可直接粘贴的 DSH `providers:` 块,导入模型不用手写 YAML |
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

`models` 是**一份统一清单**,同时接受两种本地模型来源。每一项只要有 `name`,外加 `path` 或 `url` 就够了:

```jsonc
{
  "idleTimeoutSec": 500,                       // 多久不用就释放
  "ports": { "publicBase": 8080, "internalBase": 9080 },

  "defaults": {                                // 作用于每个「托管」模型
    "ctxSize": 32768,
    "cacheTypeK": "q8_0",
    "cacheTypeV": "q4_0",
    "softContextRatio": 0.75                   // softContextLimit = ctxSize × 这个比例
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

| 写法 | 行为 |
|---|---|
| **`path`** — 托管 | 管家自己拉起 llama-server,第一次请求才加载,**闲置后把内存和显存都还回去** |
| **`url`** — 外部 | 你已经在跑的 OpenAI 兼容服务(Ollama / LM Studio / vLLM / 别的 llama.cpp)。管家只在自己的公开端口上**转发**过去,**不会**启停它,所以这类条目没有空闲释放 |

**端口自动分配。** 第 *i* 项占 `publicBase + i`;托管项从 `internalBase` 开始往上找**第一个没被占用的**端口
(所以就算你把 base 设成相邻的 8080 / 8081,也绝不会把同一个端口分给两样东西)。
想自己指定就写 `publicPort` / `internalPort`;真重复了会在**启动时**报明确错误,而不是等到拉起进程才失败。

**向后兼容。** `common` 仍可作为 `llamaServer` 的别名,老的显式写法
(每项写 `publicPort` / `internalPort` / `model` / `args`)也原样可用。

### 3.3 生成 DSH 路由

只声明模型还不够 —— DSH 那边还得有一条指向它的路由,而给每个模型手写 YAML 不可扩展。
用同一个配置直接生成:

```powershell
pwsh -File scripts/export-dsh-routes.ps1                          # 打印到 stdout
pwsh -File scripts/export-dsh-routes.ps1 -OutFile ..\routes.yml   # 或写到文件
```

它会输出一段可直接粘贴的 `providers:` 块 —— 每个模型一条路由,指向该模型的管家公开端口,
`contextWindow` 自动取 `ctxSize`。粘到 DSH profile patch 里的
`- id: llm-pi-ai` → `config:` → `providers:` 下面,然后重启 DSH。

生成器是通过 `supervisor.js --dump-models` 读配置的,所以端口分配和默认值的规则**只有一份**,
不会和管家实际行为脱节。

### 3.4 跑起来

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

### 3.5 装 DSH 插件(可选,但推荐)

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
| `models[].name` / `key` | — | 条目标识(也是默认别名) |
| `models[].path` | — | **托管**:要服务的 `.gguf` 文件 |
| `models[].url` | — | **外部**:已在运行的 OpenAI 兼容 base URL(如 `http://127.0.0.1:11434/v1`) |
| `models[].publicPort` | `publicBase + i` | 客户端连接的端口(管家占用) |
| `models[].internalPort` | `internalBase` 起第一个空闲端口 | llama-server 实际监听的端口(仅托管项) |
| `models[].alias` | `key`(或 `--alias` 参数) | `/v1/models` 报告的模型 id |
| `models[].ctxSize` | `defaults.ctxSize` | 托管项的上下文窗口 |
| `models[].cacheTypeK` / `cacheTypeV` | `defaults.*` | KV 缓存量化 |
| `models[].mtp` | 关 | 追加 `--spec-type draft-mtp`(模型含 NextN 头才划算) |
| `models[].softContextLimit` | `ctxSize × softContextRatio` | 假上下文上限,`0` = 关闭 |
| `models[].args` | 自动生成 | 进阶/兼容逃生口:直接原样传给 llama-server |
| `ports.publicBase` / `ports.internalBase` | `8080` / `9080` | 自动分配端口的起点 |
| `defaults.*` | 见模板 | 托管项的字段默认值 |
| `llamaServer.bin` / `.args` | — | 怎么启动 llama-server(`common` 是兼容别名) |

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

#### 它解决不了什么,以及一个值得记下来的漏洞

假上限只能**逼出**压缩,**不能保证压缩成功**。如果某一步把会话推得远超窗口,以至于连压缩回放
(系统提示词 + 被遮蔽区间)都超过真实窗口,那摘要请求自己也会被拒 —— 这条会话就再也救不回来了。
两条出路:**开新会话**,或把 `summarizationProvider` / `summarizationModel` 指向一个**窗口更大**的模型,
让回放有地方可跑。

这个守卫**早期版本有一个漏洞,值得写下来**,因为它真的毁掉了一条会话:

> 当时对**超过真实窗口**的请求是「直接转发,让 llama-server 自己报真实错误」。这等于在**最需要
> 守卫的时候把它关掉了**:窗口以内它照常触发、压缩照常进行;一旦越过窗口,请求就直接放行,于是
> 会话可以越过后一路无限增长。日志里看得很清楚 —— 守卫在 **26 012** token 时触发过一次,之后会话
> 涨到 **137 052** token,而后续每一次压缩回放(约 **75 000** token)都被 llama-server 自己的上限拒掉,
> 无法恢复。

现在假上限在**任何大小**下都生效,只是错误里报告的 `n_ctx` 会变(窗口以内报假上限,越过窗口报真实窗口)。
两种措辞都会被归类为 `CONTEXT_WINDOW_EXCEEDED`,所以守卫不会再把自己关掉。

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

### 模型数量多了会怎样

**没有写死只有两个模型。** 清单接受任意数量:端口从 `publicBase` / `internalBase` 自动分配、
单卡串行逻辑遍历每一项,而且插件和几个辅助脚本都改成从**同一份配置**读端口
(通过 `supervisor.js --dump-models`),不再各自硬编码一份端口表。已用 4 个模型
(2 个托管 + 2 个外部)、且故意把 base 设成相邻的方式实测通过。

清单变长时有两件事要提前规划:

- **每切换一次模型都要付一次冷启动。** 一张卡装不下两个,所以 A → B 会先停 A 再加载 B
  (视大小约 5~15 秒)。客户端如果在模型之间来回跳,就会反复付这个代价 —— 尽量把它固定在一个模型上。
- **端口段要避开你机器上的其他服务。** *N* 个模型占 `publicBase … publicBase + N − 1`,
  托管模型再从 `internalBase` 往上取空闲端口。注意别和 Ollama 的 `11434`、LM Studio 的 `1234`、
  DSH 自己的 Web 端口等撞上。**配置内部**的重复会在启动时报明确错误,不会拖到拉起进程才失败。

如果你确实想让两个模型**同时驻留**,可以起**两个管家实例**,各自用独立配置和互不重叠的端口段,
每个管自己的一个 GPU 槽位。但它们仍然共用一张卡,所以只有在这两个模型真的装得下时才有意义。

## 8. 目录结构

```
.
├─ AI-DISCLOSURE.md             AI 编写声明 —— 建议先读这个
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
│   ├─ export-dsh-routes.ps1   从 models.json 生成 DSH 的 `providers:` 配置块
│   ├─ supervisor-helpers.ps1   共享助手:从配置读端口列表、查找管家进程
│   ├─ install-autostart.ps1    登录自动启动（计划任务，装插件后可省）
│   └─ uninstall-autostart.ps1  取消
└─ LICENSE
```

## 9. 常驻开销是怎么压下来的

管家存在的意义就是"闲着待命",所以它自身的开销值得较真:

- **它解析出真正的 `node.exe`,不用版本管理器垫片。** PATH 上的 `node` 常常是垫片
  (nvm-windows 会把一个指向自己 `.shim` 目录的 junction 放进去),垫片会再启动一次真正的解释器
  —— 白多一个进程 + 约 6 MB。`scripts/supervisor-helpers.ps1` 里的 `Resolve-NodeExe` 依次优先:
  `$env:DSH_LOCAL_MODEL_NODE` → DSH 自带的 Node 运行时 → PATH 里非垫片的项。可用环境变量覆盖。
- **V8 堆加上限**(`--max-old-space-size=64`,可用 `-MaxOldSpaceMb` 调整)。在裸 `node.exe` 上实测:
  36.9 MB → 33.9 MB。**具体数值几乎不影响**(64/48/32/16 测出来一样),关键是"有上限"。
- **日志只写一次,且走一个带缓冲的句柄。** 原来是每行 `fs.appendFileSync` **外加** `console.log`,
  而启动器又把 stdout 重定向到文件 —— 等于**每行写两遍**。
- **默认丢弃 llama.cpp 的例行输出**(load tensors、slot timing、graph reuse),只保留警告/错误和少数
  关键短语;需要全量时加 `--child-log`。
- **上游套接字池化并限流**(`maxSockets: 8` / `maxFreeSockets: 2`),不再依赖 Node 的全局 agent;
  且停掉模型时会销毁连接池,避免重启后的服务收到陈旧套接字。

本机实测(Windows / Node 24):

| | 进程数 | 常驻 |
|---|---|---|
| 优化前 | 2(垫片 + 管家) | 50.1 MB |
| 优化后 | 1 | ~38~41 MB |

这已经和**一个空的 `node.exe`** 只差几 MB,基本没有可榨的了 —— 剩下的是 Node 自身
http / fs / child_process 的基线。`--jitless`、`--optimize-for-size`、`--max-semi-space-size`
都实测过,结果**更差或持平**,所以一个都没采用。

## 10. DSH 插件的实现要点

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
