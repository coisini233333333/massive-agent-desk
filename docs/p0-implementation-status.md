# P0 实施记录

2026-11-26（Asia/Shanghai）。依据 `docs/antigravity-mobile-bridge-plan.md`，基线提交 `9aa5d1b`。施工分支 `codex/mobile-bridge-p0`，独立 worktree 位于 `G:/massive agent exe/.massive-agent/worktrees/mobile-bridge`。

## 当前结论

**P0 尚未通过。** Codex 双回合续接及桌面控制器到真实 Codex 的持久派工联调已通过。桌面已有会话入口、主进程独立审阅窗口和部分审批已实现；Antigravity 原会话派工、其真人确认来源、Android APK 与端到端真机链路尚未验证。

## Antigravity 实际接口复验与当前阻塞

本轮已从[官方 Windows 安装脚本](https://antigravity.google/cli/install.ps1) 指向的发布清单下载 CLI **1.5.17**，核对 SHA-512 后运行版本与 ACP 帮助。可执行文件位于 worktree 的 `.massive-agent/tools/antigravity/agy.exe`，已被 Git 忽略；未修改全局 PATH，未运行安装脚本的原生环境设置步骤。来源与校验记录见 `artifacts/antigravity-install.json`。

`npm run probe:antigravity` 在隔离配置目录实测 ACP `initialize` 成功，协议版本 1，声明支持 `loadSession` 及会话 list/load/resume。证据：`artifacts/antigravity-capabilities.json`。它只是接口能力发现，尚未载入任何原会话。

`npm run probe:antigravity -- --check-auth` 使用正常配置做只读 `session/list`，实际返回 **-32000 / authentication-required**。证据：`artifacts/antigravity-auth-probe.json`。输出未包含会话标题、内容或认证数据。探针没有发送登录、创建会话、派工、prompt 或审批请求。

当前必须由用户完成本机 Google 登录，并指定可用于联调的原有 Antigravity 项目/会话。已发出所需信息请求。可在用户自己的终端执行：

```powershell
& 'G:\massive agent exe\.massive-agent\worktrees\mobile-bridge\.massive-agent\tools\antigravity\agy.exe' acp --login
```

不需要向聊天发送密码、Cookie 或令牌。登录后先复验只读会话接口，再验证指定原会话的稳定 ID、原文读取与确认来源。[官方 resume 文档](https://antigravity.google/docs/cli/commands/resume/)明确 App 导入会复制历史，所以是否仍为要求的原 App 对话必须实际核对。

规划的 P0 原会话验收已因这一外部依赖连续多轮受阻。本轮完成可自主进行的工具准备和只读接口复验后，仍缺少可用登录态与用户选定的原会话；依赖这些证据的后续验收不能推进。

| 规划要求 | 当前证据 | 判断 |
|---|---|---|
| 等 idea 文档定稿 | idea 已完成，规划提交 `9aa5d1b`，本轮查询无新修订 | 已完成 |
| P0 · 手机消息进入 Antigravity 原会话、完整 Google 回复及可信本人确认 | CLI 初始化通过；正常配置列会话返回 authentication-required，未指定原会话 | 外部阻塞，未通过 |
| P0 · 稳定 ID 续接 Codex，桌面打开并续聊 | Codex 原会话往返、控制器和部分 UI 有证据；桌面真人交互仍未完整验证 | 部分完成 |
| P1 · 事件、权限、回执与交接持久化，崩溃和回执丢失验收 | 绑定/草案/outbox 与部分审批已有代码及测试；持久项目事件、完整对账和交接仍缺失 | 未通过 |
| P2 · 两个 work 并行与监工切换 | 未做完整场景 | 未通过 |
| P3 · 可安装 APK、配对、跨网、锁屏通知和真机验收 | 仅桌面响应式预览；本机未发现 Android 构建工具/真机连接 | 未通过 |
| P4 · 原会话确认至手机通知的完整闭环、离线和重启 | 未做完整场景 | 未通过 |

目标尚未达到，桌面预览与原型测试不能作为全范围完成证据。

## 本轮桌面集成

- `BridgeController` 通过 SQLite 保存目录与已有会话的稳定绑定，核对会话真实 cwd 后才绑定。草案正文、修订版和可见 ticket 在同一事务提交；注入 ticket 失败时，原 queued 版本仍保留，不留下不可见的新版本。
- Electron 主进程取得实际应用单实例锁后才打开数据库并执行恢复。renderer 不接收或签发确认能力；只能请求打开独立的主进程审阅窗口。窗口展示项目、目标会话、版本、摘要与完整原文，关闭即取消。它证明本地 UI 选择的来源，不是生物识别，也不能证明 Antigravity 原对话里的确认者身份。
- 同命令并发点击只发送一次；同目标忙碌时其它命令保持 queued。客户端明确报告 not-sent 时退回 queued；回执未知则落为 unknown，禁重发。delivered 的含义是 Codex 已接收并返回 turnId，不代表任务完成。
- `serverRequest` 原文进入待办。命令审批（含声明的 humanCommand 能力）和有对应原始 fileChange 详情的文件审批，可由独立审阅窗口选择本次 accept/decline/cancel，按原 JSON-RPC ID 回包，不扩大未来权限。fileChange 详情按 threadId/turnId/itemId 绑定。已在另一端解决的请求不接受旧窗口答案。显式用户提问等其它请求保留原文但尚未实现作答 UI。
- 桌面入口采用米白、灰绿、圆角卡片、胶囊按钮及系统字体；保留原有独立 Agent 编排入口。没有复制 DSH-Go 源码或品牌素材。
- `npm test` 当前 37 项通过；实际 app-server 模型握手通过。`smoke:bridge-host` 使用测试确认回调，把持久草案发往专用测试会话，核对准确助手回复，同 commandId 再次调用返回原 turn 回执；证据 `artifacts/p0-host-smoke.json`。此测试不冒充真人点击。
- `smoke:review` 在真实 Electron 中验证 50,000 字符全文等值、HTML 按文字显示、未注册决定被拒绝、390px 无横向溢出，以及取消。截图后已调整长文窗的独立滚动区域，使决定按钮始终可见。验收脚本只自动选择取消，绝不自动批准。
- `smoke:ui:bridge` 使用隔离 userData 和专用测试会话，实际经过 preload/主进程 IPC 读取绑定与历史，验证无效目录报错后可重新检索成功，并保存桌面和 390px 截图；不会发送该截图草案。截图测试退出码为 0。它不是 Android 真机测试。

待完成：真实用户点击后的审批端到端、服务端审批重连回放、unknown 的人工证据核对与解锁、一般用户问题作答、Antigravity 连接与可信来源、持久项目事件/监工交接、多 work 协作、APK、配对通道、锁屏通知和真机测试。不能以桌面截图代替这些验收。

## 已实现和已验证

- `CodexAppServerClient` 增加分页会话发现、元数据读取、回合读取及 `continueThread` 原会话发送原语。续接只传稳定 `threadId`；`turn/start` 不覆盖模型、推理强度、目录和权限。此原语由桌面控制器在确认后调用，未开放手机或监工端点。
- 区分服务端主动审批请求与 RPC 回复；即使数字 ID 相同，也不会吞掉请求或代替用户作决定。本轮已接入上述部分桌面审批能力，其余类型不自动作答。
- 注册待返回请求后再写 stdin，修复同步回包竞态；同一会话并发发送受限；`turn/start` 回执丢失标为 `deliveryStatus=unknown`，单进程内保留发送占位，防止盲重发。该客户端占位尚未与持久登记集成，也无人工核对后的解锁接口，**不能宣称跨崩溃恰好一次**。
- 连接握手已增加共享 Promise，多个 Agent 首次同时连接时等待同一次初始化；失败初始化会释放子进程，允许显式再次连接，旧子进程迟到的退出事件不影响新连接。新增对应回归测试。
- 初始持久登记阶段 `npm test`：22 项通过；后续桌面集成阶段扩展到上述 37 项。真实 `npm run smoke:codex` 复验通过。
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

`src/main/dispatch-ledger.mjs` 是本地 SQLite 模块，本轮由 `BridgeController` 接入 Electron IPC 和 Codex 发送器；监工与手机端尚未接入：

- 保存项目、目标会话、草案确切全文、修订版和 SHA-256；确认时向可信宿主验证器传入包含 commandId 与确切版本的规范 action 摘要。宿主必须提供真实验证器，本模块不接受模型自报身份来证明真人确认。
- 确认与待发送登记在同一事务落盘。同 commandId 同内容返回已有回执，不同内容拒绝；同版草案不能用另一个 commandId 再登记一次；证明摘要具有唯一约束，防止同一证明跨派工动作重放。
- 编辑后旧版 queued 变为 superseded，未确认的旧版不能再确认；sending/unknown 的草案禁止直接编辑。送达回执同内容可重放，不同内容拒绝。
- 发送占用先落盘为 sending。恢复方法要求宿主注入的独占启动能力验证通过，才将遗留 sending 转为 unknown；打开第二连接不会自动恢复。unknown 不会再次被领取发送。本轮主进程通过 Electron 单实例锁校验宿主所有权，模块自身不获取该锁；不能把模块测试中的模拟能力当作真实独占锁。
- 测试使用临时 SQLite 和模拟的可信宿主能力，不包含真实 Antigravity、OS 本人验证、配对设备证据、进程崩溃注入或并行进程压力测试。两连接测试覆盖串行争用场景。
- 已探测本机 Electron 38.8.6 内置 Node 22.22.0、SQLite 3.50.4，可加载 `node:sqlite`；它仍会给出实验特性警告。

宿主应用单实例锁、本地审阅窗口及 Codex 发送器已接入；unknown 的人工核对流程、真实 Antigravity 确认来源仍缺失。持久本地唯一登记不能单独证明外部系统恰好收到一次；不得把模块单测当作整个 P0 的完成证据。

复现命令（在 worktree 内）：

```powershell
npm test
npm run smoke:codex
npm run smoke:bridge-codex
npm run smoke:bridge-host
npm run smoke:ui:bridge
npm run smoke:review
```

`smoke:bridge-codex` 创建专用测试对话并发送两条短消息，`smoke:bridge-host` 续接其测试会话；provider 自动重试期间可能持续数分钟，需保留原进程与工具会话句柄，不要仅因观察超时重启。`smoke:review` 故意提交一次未注册决定，`smoke:ui:bridge` 故意检索不存在的测试目录，均会打印一条预期错误来验证拒绝及恢复路径；成功时最后输出 passed 且退出码 0。Ctrl+C 是操作者显式终止，不能把它产生的中断记成远端失败。

最初未发现 Antigravity 安装；本轮已下载校验 CLI 并完成初始化探针，实际账号访问仍受登录阻塞，详见顶部复验记录。官方接口依据如下；原 App 会话的实际续接仍未通过：

- [Resume](https://antigravity.google/docs/cli/commands/resume/) 支持按 CLI 会话 ID 续接；从 App 导入会复制历史，不能据此认定仍是原 App 对话。
- [ACP](https://antigravity.google/docs/cli/acp/) 提供 stdio JSON-RPC；尚无证据证明可直接 attach 既有 App 会话。
- [Remote Control](https://antigravity.google/docs/remote-control/?tab=cli) 支持远程继续活跃会话；第三方桥接读取完整回复及可验证真人确认的能力仍待证明。模型自报“已确认”不得作为用户确认。

下一步核验真人操作的桌面闭环；有可用 Antigravity 后验证原会话读取、发消息和可信用户操作来源。关键 P0 条件未证实前，不应把完整桌面核心或 Android 界面标成已完成。

## 后续界面依据

用户指定 DSH-Go 作为主要前端参考，博客作为配色参考。已查阅 [DSH-Go shapes](https://github.com/ccch1mneyyy/dsh-go/blob/main/app/lib/ui/theme/shapes.dart) 与 [typography](https://github.com/ccch1mneyyy/dsh-go/blob/main/app/lib/ui/theme/typography.dart)，拟沿用其触屏留白、圆角卡片、胶囊控件、底部输入区和系统无衬线字体的设计思路。尚未复制源码、名称、标志或角色素材。

博客线上页面此次无法读取，配色证据来自本机 `G:/myblog/blog/src/styles/global.css`：米白 `#f7f7ef`、表面 `#fdfdf8`、墨绿 `#283e34`、强调 `#315c46`；深色底 `#171f1b`。移动端仍以 DSH-Go 的布局和可读性为主，后续需交付真实 APK 的视觉检查与真机验证。
