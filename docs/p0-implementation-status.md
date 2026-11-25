# P0 实施记录

2026-11-26（Asia/Shanghai）。依据 `docs/antigravity-mobile-bridge-plan.md`，基线提交 `9aa5d1b`。施工分支 `codex/mobile-bridge-p0`，独立 worktree 位于 `G:/massive agent exe/.massive-agent/worktrees/mobile-bridge`。

## 当前结论

**P0 尚未通过。** Codex 完整双回合联调已通过，验证稳定 ID 续接、准确助手回复及模型/推理强度保留；Antigravity 原会话派工和真人确认来源尚未测通。没有可交付 APK。

## 已实现和已验证

- `CodexAppServerClient` 增加分页会话发现、元数据读取、回合读取及 `continueThread` 原会话发送原语。续接只传稳定 `threadId`；`turn/start` 不覆盖模型、推理强度、目录和权限。此原语不构成派工审批，也未暴露为手机或监工可直接调用的端点。
- 区分服务端主动审批请求与 RPC 回复；即使数字 ID 相同，也不会吞掉请求或代替用户作决定。目前只发出 `serverRequest` 事件，Electron 审批 UI 和回包尚未接入，不能用于真实审批流程。
- 注册待返回请求后再写 stdin，修复同步回包竞态；同一会话并发发送受限；`turn/start` 回执丢失标为 `deliveryStatus=unknown`，单进程内保留发送占位，防止盲重发。该客户端占位尚未与持久登记集成，也无人工核对后的解锁接口，**不能宣称跨崩溃恰好一次**。
- 连接握手已增加共享 Promise，多个 Agent 首次同时连接时等待同一次初始化；失败初始化会释放子进程，允许显式再次连接，旧子进程迟到的退出事件不影响新连接。新增对应回归测试。
- 本轮 `npm test`：22 项通过，覆盖客户端、持久登记和原有计划逻辑。真实 `npm run smoke:codex` 复验通过。
- 真实 `model/list` 握手返回 10 个模型。
- 对独立测试会话 `01a213c8-5741-7310-83e1-48cfb78ccc1e` 的 `thread/read` 和 `thread/resume` 实测返回同一 ID，模型均为 `gpt-6.2-sol`，推理强度均为 `xhigh`。证据：`artifacts/p0-codex-attach.json`。没有向正式 idea、work 或 ICML 项目发消息。
- Codex 桌面工具 `read_thread` 能找到前一个独立测试会话 `01a213c5-ab26-78a2-b9f1-92c21b39b065`；仅证实可发现，不等于已在桌面 UI 打开并续聊。

## 实测失败与外部依赖

最初两次 `npm run smoke:bridge-codex` 在 90 秒观察超时后关闭了拥有任务的 app-server，没有拿到助手回复；遗留失败证据不应被解读为服务端自行中断。另起 app-server 读取未完成历史所显示的 `interrupted`，也不能证明原执行进程已停止。

本轮修正观察方式，持续守候原进程，收到多次可重试错误后，最终观察到 `turn/completed`；随后才读取持久历史，续接回合 `01a213ce-a9fd-7950-a122-964ff1588edd` 的助手回复准确为 `P0-DIAG`。证据：`artifacts/p0-codex-diagnostic.json`。这证明该测试会话能续接执行和读取准确回复，不证明 Antigravity 或真人确认链路。

完整双回合 smoke 已通过（退出码 0），证据为 `artifacts/p0-codex-resume.json`：测试会话 `01a213d1-a361-7430-9149-b3e69d2e096b`，首回合 `01a213d1-ab83-7920-9fea-9b82f5efd234`，续接回合 `01a213d3-6a43-7133-9244-0ba63640088b`，模型 `gpt-6.2-sol`、强度 `xhigh` 保持一致。首回合经历 4 次 `responseStreamDisconnected` 且 `willRetry=true` 后完成；续接回合也完成，准确助手回复验证通过。

smoke 脚本保留原任务：30 秒仅打印继续观察；通过原进程的 `turn/completed` 判定终态，不再因观察超时杀掉服务、也不另发替代回合。日志记录 `willRetry` 与错误码，不记录认证数据。只在指定续接回合的 `agentMessage` 中核对准确响应，避免把用户输入里的同一标记误当成回复。

成功联调后又补了两个观察异常分支：丢失回执时保留原进程；通知丢失时每 30 秒在同一 owner 查询状态和指定回合，非 active 且有终态才收束，瞬时查询失败继续观察。这些新增异常分支经过语法检查，尚未通过故意丢包的真实联调。

## 持久确认/派工登记原型

`src/main/dispatch-ledger.mjs` 是独立本地 SQLite 模块，尚未接入 Electron IPC、监工或真实发送器：

- 保存项目、目标会话、草案确切全文、修订版和 SHA-256；确认时向可信宿主验证器传入包含 commandId 与确切版本的规范 action 摘要。宿主必须提供真实验证器，本模块不接受模型自报身份来证明真人确认。
- 确认与待发送登记在同一事务落盘。同 commandId 同内容返回已有回执，不同内容拒绝；同版草案不能用另一个 commandId 再登记一次；证明摘要具有唯一约束，防止同一证明跨派工动作重放。
- 编辑后旧版 queued 变为 superseded，未确认的旧版不能再确认；sending/unknown 的草案禁止直接编辑。送达回执同内容可重放，不同内容拒绝。
- 发送占用先落盘为 sending。恢复方法要求宿主注入的独占启动能力验证通过，才将遗留 sending 转为 unknown；打开第二连接不会自动恢复。unknown 不会再次被领取发送。真实 OS 所有权验证器尚未实现，不能把测试中的模拟能力当作真实独占锁。
- 测试使用临时 SQLite 和模拟的可信宿主能力，不包含真实 Antigravity、OS 本人验证、配对设备证据、进程崩溃注入或并行进程压力测试。两连接测试覆盖串行争用场景。
- 已探测本机 Electron 38.8.6 内置 Node 22.22.0、SQLite 3.50.4，可加载 `node:sqlite`；它仍会给出实验特性警告。

仍需实现宿主独占所有权的实际约束、unknown 的证据核对流程、真实可信确认来源，以及登记到 Codex 发送器的集成。持久本地唯一登记不能单独证明外部系统恰好收到一次；不得把模块单测当作整个 P0 的完成证据。

复现命令（在 worktree 内）：

```powershell
npm test
npm run smoke:codex
npm run smoke:bridge-codex
```

最后一条会创建专用测试对话并发送两条短消息；provider 自动重试期间可能持续数分钟，需保留其原进程与工具会话句柄。不要仅因观察超时重启任务。Ctrl+C 是操作者显式终止，不能把它产生的中断记成远端失败。

本机公开命令和安装路径未发现可用的 Antigravity。已向用户请求安装路径、登录状态及可联调的测试会话。官方文档依据如下，但均不代表本机实测通过：

- [Resume](https://antigravity.google/docs/cli/commands/resume/) 支持按 CLI 会话 ID 续接；从 App 导入会复制历史，不能据此认定仍是原 App 对话。
- [ACP](https://antigravity.google/docs/cli/acp/) 提供 stdio JSON-RPC；尚无证据证明可直接 attach 既有 App 会话。
- [Remote Control](https://antigravity.google/docs/remote-control/?tab=cli) 支持远程继续活跃会话；第三方桥接读取完整回复及可验证真人确认的能力仍待证明。模型自报“已确认”不得作为用户确认。

下一步把持久登记与宿主确认/发送流程集成；有可用 Antigravity 后验证原会话读取、发消息和可信用户操作来源。关键 P0 条件未证实前，不应把后续桌面核心或 Android 界面标成已完成。

## 后续界面依据

用户指定 DSH-Go 作为主要前端参考，博客作为配色参考。已查阅 [DSH-Go shapes](https://github.com/ccch1mneyyy/dsh-go/blob/main/app/lib/ui/theme/shapes.dart) 与 [typography](https://github.com/ccch1mneyyy/dsh-go/blob/main/app/lib/ui/theme/typography.dart)，拟沿用其触屏留白、圆角卡片、胶囊控件、底部输入区和系统无衬线字体的设计思路。尚未复制源码、名称、标志或角色素材。

博客线上页面此次无法读取，配色证据来自本机 `G:/myblog/blog/src/styles/global.css`：米白 `#f7f7ef`、表面 `#fdfdf8`、墨绿 `#283e34`、强调 `#315c46`；深色底 `#171f1b`。移动端仍以 DSH-Go 的布局和可读性为主，后续需交付真实 APK 的视觉检查与真机验证。
