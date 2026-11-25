const api = window.massiveAgents;
const state = {
  bridge: { bindings: [], tickets: [], pendingRequests: [] }, selectedProjectId: null,
  discovery: { cwd: '', data: [], nextCursor: null, requestId: 0 }, history: { projectId: null, threadId: null, data: [], nextCursor: null, requestId: 0, loading: false, pendingRefresh: false },
  presets: [], models: [], count: 4, connected: false, runToCard: new Map(), waitReasons: new Map(), historyRefreshTimer: null,
  bindingExpanded: false, projectsExpanded: !window.matchMedia('(max-width: 680px)').matches, titleExpanded: false
};

const $ = selector => document.querySelector(selector);
const text = value => typeof value === 'string' ? value : '';
const selectedBinding = () => state.bridge.bindings.find(item => item.projectId === state.selectedProjectId) || null;
const draftKey = binding => binding ? `mad:bridge:draft:${binding.projectId}:${binding.threadId}` : '';
const selectedProjectKey = 'mad:bridge:selected-project';

function setFooter(value) { $('#footerStatus').textContent = value; }
function setConnection(kind, title, detail) {
  const node = $('#connectCodex'); node.className = `connection ${kind || ''}`;
  node.querySelector('b').textContent = title; node.querySelector('small').textContent = detail;
}
function setBusy(button, busy, busyText) {
  if (busy) { button.dataset.label = button.textContent; button.textContent = busyText || '处理中…'; }
  else if (button.dataset.label) { button.textContent = button.dataset.label; delete button.dataset.label; }
  button.disabled = busy;
}
function empty(node, message) { node.replaceChildren(); const item = document.createElement('div'); item.className = 'empty-state'; item.textContent = message; node.append(item); }
function status(value) {
  const node = document.createElement('span');
  const good = ['ready', 'queued', 'sending', 'delivered'].includes(value);
  node.className = `status-pill ${good ? 'is-delivered' : value === 'unknown' ? 'is-unknown' : ['superseded', 'error'].includes(value) ? 'is-error' : ''}`;
  node.textContent = value || '待确认'; return node;
}

async function refreshBridge({ keepSelection = true } = {}) {
  try {
    const previous = selectedBinding();
    const result = await api.bridgeBootstrap();
    state.bridge = { bindings: result.bindings || [], tickets: result.tickets || [], pendingRequests: result.pendingRequests || [] };
    if (typeof result.connected === 'boolean') { state.connected = result.connected; setConnection(result.connected ? 'connected' : '', result.connected ? '已连接本地 Codex' : 'Codex 未连接', result.connected ? '桥接正在使用本地 app-server' : '点击连接本地 app-server'); }
    if (!keepSelection || !selectedBinding()) {
      const remembered = keepSelection ? localStorage.getItem(selectedProjectKey) : null;
      state.selectedProjectId = state.bridge.bindings.find(item => item.projectId === remembered)?.projectId || state.bridge.bindings[0]?.projectId || null;
    }
    const current = selectedBinding();
    if (previous && (!current || previous.projectId !== current.projectId || previous.threadId !== current.threadId)) resetHistory();
    if (current) localStorage.setItem(selectedProjectKey, current.projectId); else localStorage.removeItem(selectedProjectKey);
    renderProjects(); renderSelection();
  } catch (error) { setFooter(`桥接状态读取失败：${error.message}`); }
}
function renderProjects() {
  $('#projectSidebar').classList.toggle('is-expanded', state.projectsExpanded);
  $('#projectToggle').textContent = state.projectsExpanded ? '收起' : '项目'; $('#projectToggle').setAttribute('aria-expanded', String(state.projectsExpanded));
  const root = $('#projectList'); root.replaceChildren();
  if (!state.bridge.bindings.length) { empty(root, '还没有绑定项目。选择目录并从已有会话中绑定一个入口。'); return; }
  for (const binding of state.bridge.bindings) {
    const row = document.createElement('button'); row.type = 'button'; row.className = `project-row ${binding.projectId === state.selectedProjectId ? 'is-active' : ''}`;
    const name = document.createElement('strong'); name.textContent = binding.name;
    const title = document.createElement('span'); title.textContent = binding.title || '未命名会话';
    const id = document.createElement('small'); id.textContent = binding.threadId;
    row.append(name, title, id); row.onclick = () => selectProject(binding.projectId); root.append(row);
  }
}
async function selectProject(projectId) {
  if (projectId === state.selectedProjectId) return;
  state.selectedProjectId = projectId; state.titleExpanded = false; localStorage.setItem(selectedProjectKey, projectId); resetHistory();
  renderProjects(); renderSelection(); await loadHistory(true);
}
function resetHistory() { state.history = { projectId: null, threadId: null, data: [], nextCursor: null, requestId: state.history.requestId + 1, loading: false, pendingRefresh: false }; }
function renderSelection() {
  const binding = selectedBinding(); const draft = $('#draftText');
  $('#bindingTitle').textContent = binding ? '当前会话入口' : '从已有 Codex 会话开始';
  $('#bindingStatus').textContent = binding ? '已绑定' : '未选择项目'; $('#bindingStatus').className = `status-pill ${binding ? 'is-delivered' : ''}`;
  $('#draftTarget').textContent = binding ? `→ ${binding.name}` : '尚未绑定目标'; $('#draftTarget').className = `status-pill ${binding ? 'is-delivered' : ''}`;
  renderBindingDisclosure(binding); renderConversationTitle(binding ? binding.title || binding.name : '选择项目以查看对话');
  $('#conversationMeta').textContent = binding ? `${binding.name} · ${binding.threadId}` : '不会创建或修改任何会话。';
  draft.disabled = !binding; $('#prepareDraft').disabled = !binding;
  draft.placeholder = binding ? '写入并保存一个版本；发送前会再次显示确切原文。' : '先选择一个已绑定项目。';
  draft.value = binding ? localStorage.getItem(draftKey(binding)) || '' : ''; updateCount(); renderTickets(); renderApprovals();
  if (!binding) empty($('#timeline'), '绑定一个项目后，这里会完整显示该会话的历史。');
  else if (state.history.projectId !== binding.projectId || state.history.threadId !== binding.threadId) empty($('#timeline'), '正在等待读取这条已有会话。');
}
function renderBindingDisclosure(binding) {
  const toggle = $('#bindingToggle'), controls = $('#bindingControls');
  toggle.hidden = !binding;
  if (!binding) { controls.hidden = false; return; }
  controls.hidden = !state.bindingExpanded; toggle.setAttribute('aria-expanded', String(state.bindingExpanded));
  toggle.textContent = state.bindingExpanded ? '收起会话检索' : '更换/绑定其它会话';
}
function renderConversationTitle(value) {
  const title = $('#conversationTitle'), toggle = $('#titleToggle'); const long = value.length > 82;
  title.textContent = value; title.title = value; title.classList.toggle('is-expanded', long && state.titleExpanded);
  toggle.hidden = !long; toggle.setAttribute('aria-expanded', String(long && state.titleExpanded));
  toggle.textContent = state.titleExpanded ? '收起标题' : '查看完整标题';
}

function itemText(item) {
  if (item.type === 'agentMessage') return text(item.text);
  if (item.type === 'userMessage') return (item.content || []).filter(part => ['text', 'input_text'].includes(part.type)).map(part => text(part.text)).join('\n');
  return '';
}
function renderHistory() {
  const root = $('#timeline'); root.replaceChildren();
  if (!state.history.data.length) { empty(root, '这条会话暂时没有可显示的历史内容。'); return; }
  for (const turn of [...state.history.data].reverse()) {
    const section = document.createElement('article'); section.className = 'turn';
    for (const item of turn.items || []) {
      const value = itemText(item);
      if (value) {
        const message = document.createElement('div'); message.className = `message ${item.type === 'userMessage' ? 'user' : 'agent'}`;
        const label = document.createElement('span'); label.className = 'message-meta'; label.textContent = item.type === 'userMessage' ? '用户消息' : 'Codex';
        const body = document.createElement('div'); body.textContent = value; message.append(label, body); section.append(message);
      } else if (item.type) {
        const details = document.createElement('details'); details.className = 'tool-details';
        const summary = document.createElement('summary'); summary.textContent = `展开 ${item.type}`;
        const pre = document.createElement('pre'); pre.textContent = JSON.stringify(item, null, 2); details.append(summary, pre); section.append(details);
      }
    }
    if (section.childElementCount) root.append(section);
  }
  $('#loadMoreHistory').hidden = !state.history.nextCursor;
}
async function loadHistory(reset = false) {
  const binding = selectedBinding(); if (!binding) return;
  if (state.history.loading) { if (reset) state.history.pendingRefresh = true; return; }
  const target = { projectId: binding.projectId, threadId: binding.threadId };
  const requestId = state.history.requestId + 1;
  state.history.requestId = requestId; state.history.loading = true;
  const button = $('#loadMoreHistory'); setBusy(button, true, '读取中…');
  try {
    const result = await api.bridgeHistory({ projectId: target.projectId, cursor: reset ? undefined : state.history.nextCursor });
    const current = selectedBinding();
    if (!current || current.projectId !== target.projectId || current.threadId !== target.threadId || state.history.requestId !== requestId) return;
    state.history = { projectId: target.projectId, threadId: target.threadId, data: reset ? result.data || [] : [...state.history.data, ...(result.data || [])], nextCursor: result.nextCursor || null, requestId, loading: false, pendingRefresh: state.history.pendingRefresh };
    renderHistory();
    await refreshBridge();
  } catch (error) { const current = selectedBinding(); if (current?.projectId === target.projectId && current.threadId === target.threadId && state.history.requestId === requestId) { empty($('#timeline'), `无法读取历史：${error.message}`); setFooter(`历史读取失败：${error.message}`); } }
  finally { if (state.history.requestId === requestId) { state.history.loading = false; if (state.history.pendingRefresh) { state.history.pendingRefresh = false; queueMicrotask(() => loadHistory(true)); } } setBusy(button, false); }
}

async function listThreads(more = false) {
  const cwd = $('#bridgeWorkspace').value.trim(); if (!cwd) { setFooter('请先选择项目目录。'); return; }
  const append = more && state.discovery.cwd === cwd;
  const button = append ? $('#loadMoreThreads') : $('#listThreads'); const requestId = state.discovery.requestId + 1; state.discovery.requestId = requestId; setBusy(button, true, '读取中…');
  try {
    const result = await api.bridgeListThreads({ cwd, cursor: append ? state.discovery.nextCursor : undefined });
    if ($('#bridgeWorkspace').value.trim() !== cwd || state.discovery.requestId !== requestId) return;
    state.discovery = { cwd, data: append ? [...state.discovery.data, ...(result.data || [])] : result.data || [], nextCursor: result.nextCursor || null, requestId };
    renderThreads(); setFooter(`已找到 ${state.discovery.data.length} 条本机会话`); await refreshBridge();
  } catch (error) { if ($('#bridgeWorkspace').value.trim() !== cwd || state.discovery.requestId !== requestId) return; state.discovery = { cwd, data: [], nextCursor: null, requestId }; renderThreads(`无法读取会话：${error.message}`); setFooter(`会话检索失败：${error.message}`); }
  finally { setBusy(button, false); }
}
function renderThreads(problem) {
  const root = $('#threadList'); root.replaceChildren();
  if (problem) { empty(root, problem); $('#loadMoreThreads').hidden = true; return; }
  if (!state.discovery.data.length) { empty(root, '没有找到可绑定的会话。请确认目录与 Codex 历史一致。'); $('#loadMoreThreads').hidden = true; return; }
  for (const thread of state.discovery.data) {
    const row = document.createElement('article'); row.className = 'thread-row'; const copy = document.createElement('div'); copy.className = 'thread-copy';
    const title = document.createElement('strong'); title.textContent = thread.name || thread.preview || '未命名会话'; const preview = document.createElement('p'); preview.textContent = thread.preview || '没有可用摘要'; const id = document.createElement('code'); id.textContent = thread.id; copy.append(title, preview, id);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button'; button.textContent = '绑定此会话'; button.onclick = () => bindThread(thread, button); row.append(copy, button); root.append(row);
  }
  $('#loadMoreThreads').hidden = !state.discovery.nextCursor;
}
async function bindThread(thread, button) {
  if (!state.discovery.cwd) return; setBusy(button, true, '绑定中…');
  try {
    const binding = await api.bridgeBind({ cwd: state.discovery.cwd, threadId: thread.id }); await refreshBridge({ keepSelection: false }); state.selectedProjectId = binding.projectId; state.bindingExpanded = false; state.titleExpanded = false; localStorage.setItem(selectedProjectKey, binding.projectId); resetHistory(); renderProjects(); renderSelection(); await loadHistory(true); setFooter(`已绑定 ${binding.name} 的已有会话`);
  } catch (error) { setFooter(`绑定失败：${error.message}`); }
  finally { setBusy(button, false); }
}

function updateCount() { $('#draftCount').textContent = `${$('#draftText').value.length} / 50000`; }
function renderTickets() {
  const root = $('#ticketList'); root.replaceChildren(); const binding = selectedBinding(); if (!binding) return;
  for (const ticket of state.bridge.tickets.filter(value => value.projectId === binding.projectId)) {
    const card = document.createElement('article'); card.className = 'ticket'; const head = document.createElement('div'); head.className = 'ticket-head'; const heading = document.createElement('h3'); heading.textContent = `草案版本 ${ticket.revision}`; head.append(heading, status(ticket.state));
    const meta = document.createElement('div'); meta.className = 'ticket-meta'; meta.textContent = `目标 ${ticket.targetThreadId} · 命令 ${ticket.commandId}`;
    const content = document.createElement('pre'); content.textContent = ticket.text; card.append(head, meta, content);
    const waitReason = ticket.waitReason || state.waitReasons.get(ticket.commandId);
    if (waitReason) { const note = document.createElement('p'); note.className = 'ticket-warning'; note.textContent = waitReason; card.append(note); }
    if (ticket.state === 'unknown') { const note = document.createElement('p'); note.className = 'ticket-warning'; note.textContent = '发送结果待核对。为避免重复派工，界面不会提供重试。'; card.append(note); }
    if (ticket.outcomeDetail || ticket.receipt) { const receipt = document.createElement('p'); receipt.className = 'ticket-meta'; receipt.textContent = `回执：${ticket.outcomeDetail || ticket.receipt}`; card.append(receipt); }
    if (['ready', 'queued'].includes(ticket.state)) { const actions = document.createElement('div'); actions.className = 'ticket-actions'; const send = document.createElement('button'); send.type = 'button'; send.className = 'primary-button'; send.textContent = ticket.state === 'ready' ? '查看并确认发送' : '继续发送已确认版本'; send.onclick = () => confirmTicket(ticket, send); actions.append(send); card.append(actions); }
    root.append(card);
  }
}
function renderApprovals() {
  const root = $('#approvalList'); root.replaceChildren();
  for (const request of state.bridge.pendingRequests || []) {
    const card = document.createElement('article'); card.className = 'approval-card'; const title = document.createElement('h3'); title.textContent = request.method || 'Codex 请求'; const label = document.createElement('p'); label.textContent = request.status === 'answer-sent' ? '决定已发送，等待 Codex 核对。' : `原始 Codex 请求 · 会话 ${request.params?.threadId || '未提供标识'}`; card.append(title, label);
    const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = '查看原始请求'; const pre = document.createElement('pre'); pre.textContent = JSON.stringify(request.params || request, null, 2); details.append(summary, pre); card.append(details);
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method);
    if (request.status === 'pending' && supported && typeof api.bridgeResolveRequest === 'function') { const actions = document.createElement('div'); actions.className = 'ticket-actions'; const button = document.createElement('button'); button.type = 'button'; button.className = 'primary-button'; button.textContent = '查看并审批'; button.onclick = () => resolveRequest(request, button); actions.append(button); card.append(actions); }
    else if (request.status === 'pending') { const note = document.createElement('p'); note.className = 'ticket-warning'; note.textContent = supported ? '桌面审批暂不可用。请保留原文并在原会话处理。' : '这类用户问题尚未支持在桥接端作答；原始内容已保留。'; card.append(note); }
    root.append(card);
  }
}
async function resolveRequest(request, button) { setBusy(button, true, '打开审批…'); try { await api.bridgeResolveRequest({ requestId: request.id }); await refreshBridge(); } catch (error) { setFooter(`审批未完成：${error.message}`); } finally { setBusy(button, false); } }
async function prepareDraft() {
  const binding = selectedBinding(), draft = $('#draftText'), sentText = draft.value, key = draftKey(binding); if (!binding || !sentText.trim()) return; const button = $('#prepareDraft'); setBusy(button, true, '保存中…');
  try { const ticket = await api.bridgePrepare({ projectId: binding.projectId, text: sentText }); if (localStorage.getItem(key) === sentText) localStorage.removeItem(key); if (selectedBinding()?.projectId === binding.projectId && selectedBinding()?.threadId === binding.threadId && draft.value === sentText) { draft.value = ''; updateCount(); } await refreshBridge(); setFooter(`已保存草案版本 ${ticket.revision}，请核对确切原文后发送。`); }
  catch (error) { setFooter(`保存草案失败：${error.message}`); } finally { setBusy(button, false); }
}
async function confirmTicket(ticket, button) {
  setBusy(button, true, '等待确认…');
  try { const result = await api.bridgeConfirm({ commandId: ticket.commandId }); if (result.waitReason) state.waitReasons.set(ticket.commandId, result.waitReason); else state.waitReasons.delete(ticket.commandId); await refreshBridge(); if (result.cancelled) setFooter('已取消发送，草案仍保留供你再次核对。'); else if (result.waitReason) setFooter(result.waitReason); else setFooter(result.state === 'delivered' ? 'Codex 已收到该版本。任务仍可能在执行。' : `草案状态：${result.state}`); }
  catch (error) { setFooter(`发送未完成：${error.message}`); await refreshBridge(); } finally { setBusy(button, false); }
}

function normalizeEfforts(model) { const values = (model?.supportedReasoningEfforts || []).map(item => typeof item === 'string' ? item : item.reasoningEffort).filter(Boolean); return values.length ? values : ['low', 'medium', 'high', 'xhigh']; }
function cardConfig(card, index) { return { runId: `agent-${index + 1}`, presetId: card.querySelector('.role-select').value, model: card.querySelector('.model-select').value, effort: card.querySelector('.effort-select').value, enabled: true }; }
function cardsSnapshot() { return [...$('#agentGrid').children].map(cardConfig); }
function fillModels(card, selectedModel, selectedEffort) {
  const model = card.querySelector('.model-select'), effort = card.querySelector('.effort-select'); model.replaceChildren(...state.models.map(value => { const option = document.createElement('option'); option.value = value.model || value.id; option.textContent = value.displayName || value.model || value.id; return option; })); if (state.models.some(value => (value.model || value.id) === selectedModel)) model.value = selectedModel;
  const update = preferred => { const current = state.models.find(value => (value.model || value.id) === model.value); const efforts = normalizeEfforts(current); effort.replaceChildren(...efforts.map(value => { const option = document.createElement('option'); option.value = value; option.textContent = value.toUpperCase(); return option; })); effort.value = efforts.includes(preferred) ? preferred : current?.defaultReasoningEffort || efforts[0]; }; update(selectedEffort); model.onchange = () => update();
}
function renderCards(preferred = cardsSnapshot()) {
  const root = $('#agentGrid'); root.replaceChildren(); state.runToCard.clear();
  for (let index = 0; index < state.count; index += 1) { const card = $('#agentCardTemplate').content.firstElementChild.cloneNode(true), saved = preferred[index] || {}, preset = state.presets.find(value => value.id === saved.presetId) || state.presets[index % state.presets.length]; card.querySelector('.agent-index').textContent = `AGENT ${String(index + 1).padStart(2, '0')}`; card.querySelector('.role-badge').textContent = preset.badge; card.querySelector('.role-summary').textContent = preset.summary; const role = card.querySelector('.role-select'); role.replaceChildren(...state.presets.map(value => { const option = document.createElement('option'); option.value = value.id; option.textContent = value.label; return option; })); role.value = preset.id; fillModels(card, saved.model || preset.defaultModel, saved.effort || preset.defaultEffort); role.onchange = () => { const next = state.presets.find(value => value.id === role.value); card.querySelector('.role-badge').textContent = next.badge; card.querySelector('.role-summary').textContent = next.summary; fillModels(card, next.defaultModel, next.defaultEffort); }; card.querySelector('.stop-button').onclick = () => { if (card.dataset.runId) api.interrupt(card.dataset.runId); }; root.append(card); }
}
function appendOutput(card, value) { if (!value) return; const output = card.querySelector('.agent-output'); if (output.textContent === '等待任务…' || output.textContent === '正在启动 Codex 线程…') output.textContent = ''; output.textContent += value; if (output.textContent.length > 18000) output.textContent = output.textContent.slice(-18000); output.scrollTop = output.scrollHeight; }
function eventThreadId(event) { return event.threadId || event.params?.threadId || event.params?.turn?.threadId || event.params?.item?.threadId; }
function queueHistoryRefresh(immediate = false) {
  clearTimeout(state.historyRefreshTimer);
  state.historyRefreshTimer = setTimeout(() => { const binding = selectedBinding(); if (binding) loadHistory(true); }, immediate ? 0 : 350);
}
function handleEvent(event) {
  const binding = selectedBinding();
  if (binding && eventThreadId(event) === binding.threadId && /^(turn|item)\//.test(event.method || '')) queueHistoryRefresh(event.method === 'turn/completed');
  const card = event.runId ? state.runToCard.get(event.runId) : null; if (!card) return;
  const params = event.params || {}; appendOutput(card, params.delta || params.text || params.item?.text || ''); const tag = card.querySelector('.agent-status');
  if (event.method === 'turn/started') { tag.textContent = 'RUNNING'; tag.className = 'agent-status running'; }
  if (event.method === 'turn/completed') { const outcome = params.turn?.status || 'completed'; tag.textContent = String(outcome).toUpperCase(); tag.className = outcome === 'completed' ? 'agent-status done' : 'agent-status error'; card.querySelector('.stop-button').disabled = true; }
}
async function connect() { setConnection('', '正在连接 Codex', '启动本地 app-server'); try { const result = await api.connect(); if (result.models?.length) { const current = cardsSnapshot(); state.models = result.models; renderCards(current); } state.connected = true; setConnection('connected', 'Codex 已连接', `${state.models.length} 个可用模型`); } catch (error) { state.connected = false; setConnection('error', 'Codex 连接失败', error.message); setFooter(`连接错误：${error.message}`); } }
async function launch() {
  const button = $('#launchRun'), cards = [...$('#agentGrid').children], config = { workspace: $('#workspaceInput').value, task: $('#task').value, agents: cards.map(cardConfig) }; setBusy(button, true, '启动中…');
  cards.forEach((card, index) => { const runId = config.agents[index].runId; card.dataset.runId = runId; state.runToCard.set(runId, card); card.querySelector('.agent-output').textContent = '正在启动 Codex 线程…'; card.querySelector('.agent-status').textContent = 'STARTING'; card.querySelector('.stop-button').disabled = false; });
  try { if (!state.connected) await connect(); const results = await api.launchRun(config); results.forEach(result => { const card = state.runToCard.get(result.runId); if (!card || result.ok) return; card.querySelector('.agent-status').textContent = 'ERROR'; card.querySelector('.agent-status').className = 'agent-status error'; card.querySelector('.agent-output').textContent = result.error; }); setFooter(`已启动 ${results.filter(value => value.ok).length}/${results.length} 个 Agent`); } catch (error) { setFooter(`启动失败：${error.message}`); } finally { setBusy(button, false); }
}
function showMode(mode) { document.querySelectorAll('.mode-tab').forEach(button => { const active = button.dataset.mode === mode; button.classList.toggle('is-active', active); button.setAttribute('aria-selected', String(active)); }); $('#bridgeView').hidden = mode !== 'bridge'; $('#orchestrateView').hidden = mode !== 'orchestrate'; }

async function init() {
  const app = await api.bootstrap(); state.presets = app.presets || []; state.models = app.fallbackModels || []; const saved = app.saved;
  if (saved) { $('#workspaceInput').value = saved.workspace || ''; $('#task').value = saved.task || ''; state.count = Math.max(1, Math.min(8, saved.agents?.length || 4)); }
  $('#agentCount').textContent = state.count; renderCards(saved?.agents || []); document.querySelectorAll('.mode-tab').forEach(button => button.onclick = () => showMode(button.dataset.mode));
  $('#connectCodex').onclick = connect; $('#pickBridgeWorkspace').onclick = async () => { const path = await api.pickWorkspace(); if (path) { $('#bridgeWorkspace').value = path; listThreads(); } }; $('#listThreads').onclick = () => listThreads(); $('#loadMoreThreads').onclick = () => listThreads(true); $('#loadMoreHistory').onclick = () => loadHistory(); $('#refreshBridge').onclick = refreshBridge;
  $('#bindingToggle').onclick = () => { state.bindingExpanded = !state.bindingExpanded; renderBindingDisclosure(selectedBinding()); }; $('#projectToggle').onclick = () => { state.projectsExpanded = !state.projectsExpanded; renderProjects(); }; $('#titleToggle').onclick = () => { state.titleExpanded = !state.titleExpanded; renderConversationTitle(selectedBinding()?.title || selectedBinding()?.name || '选择项目以查看对话'); };
  $('#draftText').oninput = () => { const binding = selectedBinding(); if (binding) localStorage.setItem(draftKey(binding), $('#draftText').value); updateCount(); }; $('#prepareDraft').onclick = prepareDraft;
  $('#pickWorkspace').onclick = async () => { const path = await api.pickWorkspace(); if (path) $('#workspaceInput').value = path; }; $('#minusCount').onclick = () => { state.count = Math.max(1, state.count - 1); $('#agentCount').textContent = state.count; renderCards(); }; $('#plusCount').onclick = () => { state.count = Math.min(8, state.count + 1); $('#agentCount').textContent = state.count; renderCards(); }; $('#launchRun').onclick = launch;
  api.onEvent(handleEvent); api.onDiagnostic(value => { if (/error|failed/i.test(value)) setFooter(value.trim().slice(0, 180)); }); api.onBridge(() => refreshBridge()); await refreshBridge(); if (selectedBinding()) await loadHistory(true); else renderSelection();
}
init().catch(error => { setConnection('error', '初始化失败', error.message); setFooter(error.message); });
