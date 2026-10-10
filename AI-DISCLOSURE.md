# AI authorship disclosure

[English](#english) | [中文](#中文)

---

<a id="english"></a>
## English

**This project was written by an AI coding agent, not by hand.**

Every file in this repository — `supervisor/supervisor.js`, the DSH plugin, the PowerShell
helpers and this documentation — was produced by an AI assistant working from a human's
requirements, on the human's machine, against a real llama.cpp + DSH installation.

What that means for anyone downloading it:

- **Read the code before you run it.** The supervisor binds local ports, spawns and kills
  `llama-server` processes, and proxies HTTP traffic — including your prompts and completions.
  Read it first (the core is roughly 600 lines of dependency-free Node) before pointing it at
  anything you care about.
- **No warranty.** The MIT licence applies as usual. Nothing here has been through a security
  review or a formal test suite.
- **Verified on exactly one machine.** Every number in the *Measured results* table comes from
  Windows 11 + RTX 4070 Ti + llama.cpp CUDA + DSH. Linux, macOS, other GPUs and other llama.cpp
  builds are untested.
- **Part of it is reverse-engineered.** The soft context ceiling depends on how DSH's pi-ai
  adapter classifies llama.cpp's overflow error. That was read out of the shipped DSH bundle, not
  from a documented public contract, so it can silently stop working when DSH changes.
  See README section 5.
- **Expect bugs.** Two were caught only by actually running the code during development — a port
  allocation collision, and a stale variable reference left behind by a rename. Both are fixed,
  but that says more about how the code was tested than about what is still lurking.
- **Configuration is not AI-guessed for you.** Model paths, ports, `llama-server` arguments and
  context sizes are yours to set; the defaults shipped here are one machine's tuning choices, not
  universal recommendations.

Corrections, issue reports and pull requests are welcome — especially from anyone running it on
hardware or an OS other than the one above.

---

<a id="中文"></a>
## 中文

**本项目由 AI 编码助手编写,不是手写的。**

仓库里的每个文件 —— `supervisor/supervisor.js`、DSH 插件、PowerShell 辅助脚本以及本文档 ——
都是 AI 助手按照人类提出的需求、在人类的机器上、对着真实的 llama.cpp + DSH 环境产出的。

对下载使用者意味着什么:

- **运行前请先读代码。** 管家会占用本地端口、拉起并杀掉 `llama-server` 进程、转发包括提示词与
  补全在内的 HTTP 流量。建议先过一遍(核心是约 600 行、零依赖的 Node 代码),再拿它对接你在意的东西。
- **没有担保。** 照常适用 MIT 许可。本项目没有经过安全审计,也没有正式的测试套件。
- **只在一种机器上验证过。** 「实测数据」里的每个数字都来自 Windows 11 + RTX 4070 Ti +
  llama.cpp CUDA + DSH。Linux / macOS、其他显卡与其他 llama.cpp 构建**均未测试**。
- **部分知识是逆向来的。** 软上下文上限依赖 DSH 的 pi-ai 适配器如何归类 llama.cpp 的溢出错误 ——
  这是从 DSH 随包发布的产物里读出来的,**不是公开契约**,所以 DSH 升级后可能静默失效(见 README 第 5 节)。
- **很可能还有 bug。** 开发过程中就靠真跑代码抓出过两个:端口分配撞车、重命名后遗留的旧变量引用。
  都已修复,但这说明的更多是「代码是怎么被测的」,而不是「还剩多少没被发现」。
- **配置不是替你猜好的。** 模型路径、端口、`llama-server` 参数、上下文长度都要你自己定;
  仓库里的默认值只是**某台机器的调优选择**,不是通用建议。

欢迎提 issue 与 PR —— 尤其欢迎在上述以外的硬件或系统上跑过的人反馈。
