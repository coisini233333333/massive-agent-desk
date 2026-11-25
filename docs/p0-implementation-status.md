# P0 实施记录

2026-11-26（Asia/Shanghai）。依据 `docs/antigravity-mobile-bridge-plan.md`，基线提交 `9aa5d1b`。施工分支 `codex/mobile-bridge-p0`，独立 worktree 位于 `G:/massive agent exe/.massive-agent/worktrees/mobile-bridge`。

## 当前结论

**P0 尚未通过。** Codex 稳定 ID 读取/续接 RPC 已实测；完整回复、Antigravity 原会话派工和真人确认来源尚未测通。未开始 P1–P4 产品施工，没有可交付 APK。

## 已实现和已验证

- `CodexAppServerClient` 增加分页会话发现、元数据读取、回合读取及 `continueThread` 原会话发送原语。续接只传稳定 `threadId`；`turn/start` 不覆盖模型、推理强度、目录和权限。此原语不构成派工审批，也未暴露为手机或监工可直接调用的端点。
- 区分服务端主动审批请求与 RPC 回复；即使数字 ID 相同，也不会吞掉请求或代替用户作决定。目前只发出 `serverRequest` 事件，Electron 审批 UI 和回包尚未接入，不能用于真实审批流程。
- 注册待返回请求后再写 stdin，修复同步回包竞态；同一会话并发发送受限；`turn/start` 回执丢失标为 `deliveryStatus=unknown`，单进程内保留发送占位，防止盲重发。占位尚未持久化，也无人工核对后的解锁接口，**不能宣称跨崩溃恰好一次**。
- `npm test`：9 项通过，覆盖保留 ID/不覆盖配置、活动会话拒发、审批 ID 冲突、提前完成、回执超时禁重发和原有计划逻辑。
- 真实 `model/list` 握手返回 10 个模型。
- 对独立测试会话 `01a213c8-5741-7310-83e1-48cfb78ccc1e` 的 `thread/read` 和 `thread/resume` 实测返回同一 ID，模型均为 `gpt-6.2-sol`，推理强度均为 `xhigh`。证据：`artifacts/p0-codex-attach.json`。没有向正式 idea、work 或 ICML 项目发消息。
- Codex 桌面工具 `read_thread` 能找到前一个独立测试会话 `01a213c5-ab26-78a2-b9f1-92c21b39b065`；仅证实可发现，不等于已在桌面 UI 打开并续聊。

## 实测失败与外部依赖

`npm run smoke:bridge-codex` 两次创建独立测试会话并发送禁止工具调用的短文本，均未收到模型回复。运行中另一个 app-server 的 `thread/read` 观察到回合 `interrupted`、仅含 `userMessage`。第一次使用现有默认配置 `gpt-6.1-sol`，第二次明确使用 `model/list` 默认 `gpt-6.2-sol`。没有证据能确定中断原因。最新失败证据位于 `artifacts/p0-codex-resume.json`。脚本已改为轮询权威历史、只校验助手输出，且校验续接前后模型与强度；这些后续改动通过静态语法检查，尚无成功的模型往返结果。

复现命令（在 worktree 内）：

```powershell
npm test
npm run smoke:codex
npm run smoke:bridge-codex
```

最后一条会创建专用测试对话并发送两条短消息；当前应视为待修复的集成检查。失败时保留会话 ID，先读真实状态，不在观察超时后直接重发。

本机公开命令和安装路径未发现可用的 Antigravity。已向用户请求安装路径、登录状态及可联调的测试会话。官方文档依据如下，但均不代表本机实测通过：

- [Resume](https://antigravity.google/docs/cli/commands/resume/) 支持按 CLI 会话 ID 续接；从 App 导入会复制历史，不能据此认定仍是原 App 对话。
- [ACP](https://antigravity.google/docs/cli/acp/) 提供 stdio JSON-RPC；尚无证据证明可直接 attach 既有 App 会话。
- [Remote Control](https://antigravity.google/docs/remote-control/?tab=cli) 支持远程继续活跃会话；第三方桥接读取完整回复及可验证真人确认的能力仍待证明。模型自报“已确认”不得作为用户确认。

下一步先诊断 Codex 测试回合中断原因；有可用 Antigravity 后验证原会话读取、发消息和可信用户操作来源。关键 P0 条件未证实前，不应把后续桌面核心或 Android 界面标成已完成。

## 后续界面依据

用户指定 DSH-Go 作为主要前端参考，博客作为配色参考。已查阅 [DSH-Go shapes](https://github.com/ccch1mneyyy/dsh-go/blob/main/app/lib/ui/theme/shapes.dart) 与 [typography](https://github.com/ccch1mneyyy/dsh-go/blob/main/app/lib/ui/theme/typography.dart)，拟沿用其触屏留白、圆角卡片、胶囊控件、底部输入区和系统无衬线字体的设计思路。尚未复制源码、名称、标志或角色素材。

博客线上页面此次无法读取，配色证据来自本机 `G:/myblog/blog/src/styles/global.css`：米白 `#f7f7ef`、表面 `#fdfdf8`、墨绿 `#283e34`、强调 `#315c46`；深色底 `#171f1b`。移动端仍以 DSH-Go 的布局和可读性为主，后续需交付真实 APK 的视觉检查与真机验证。
