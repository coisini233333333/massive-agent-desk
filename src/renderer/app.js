const state = {
  presets: [],
  models: [],
  count: 4,
  cards: [],
  runToCard: new Map(),
  connected: false
};

const $ = selector => document.querySelector(selector);
const grid = $('#agentGrid');
const template = $('#agentCardTemplate');

function normalizeEfforts(model) {
  const values = (model?.supportedReasoningEfforts || []).map(item => typeof item === 'string' ? item : item.reasoningEffort).filter(Boolean);
  return values.length ? values : ['low', 'medium', 'high', 'xhigh'];
}

function currentCardConfig(card, index) {
  return {
    runId: `agent-${index + 1}`,
    presetId: card.querySelector('.role-select').value,
    model: card.querySelector('.model-select').value,
    effort: card.querySelector('.effort-select').value,
    enabled: true
  };
}

function snapshotCards() {
  return [...grid.children].map(currentCardConfig);
}

function setConnection(kind, title, detail) {
  const node = $('#connectionState');
  node.className = `connection ${kind || ''}`;
  node.querySelector('b').textContent = title;
  node.querySelector('small').textContent = detail;
}

function fillModels(card, selectedModel, selectedEffort) {
  const modelSelect = card.querySelector('.model-select');
  const effortSelect = card.querySelector('.effort-select');
  modelSelect.replaceChildren(...state.models.map(model => {
    const option = document.createElement('option');
    option.value = model.model || model.id;
    option.textContent = model.displayName || model.model || model.id;
    return option;
  }));
  if (state.models.some(model => (model.model || model.id) === selectedModel)) modelSelect.value = selectedModel;

  const updateEfforts = preferred => {
    const model = state.models.find(item => (item.model || item.id) === modelSelect.value);
    const efforts = normalizeEfforts(model);
    effortSelect.replaceChildren(...efforts.map(effort => {
      const option = document.createElement('option');
      option.value = effort;
      option.textContent = effort.toUpperCase();
      return option;
    }));
    const target = efforts.includes(preferred) ? preferred : (model?.defaultReasoningEffort || efforts[0]);
    effortSelect.value = target;
  };
  updateEfforts(selectedEffort);
  modelSelect.onchange = () => updateEfforts();
}

function applyPreset(card, preset, keepModel = false) {
  card.style.setProperty('--accent', preset.accent);
  card.querySelector('.role-badge').textContent = preset.badge;
  card.querySelector('.role-summary').textContent = preset.summary;
  if (!keepModel) fillModels(card, preset.defaultModel, preset.defaultEffort);
}

function renderCards(preferred = snapshotCards()) {
  grid.replaceChildren();
  state.runToCard.clear();
  for (let index = 0; index < state.count; index += 1) {
    const card = template.content.firstElementChild.cloneNode(true);
    const saved = preferred[index] || {};
    const preset = state.presets.find(item => item.id === saved.presetId) || state.presets[index % state.presets.length];
    card.querySelector('.agent-index').textContent = `AGENT ${String(index + 1).padStart(2, '0')}`;

    const roleSelect = card.querySelector('.role-select');
    roleSelect.replaceChildren(...state.presets.map(item => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.label;
      return option;
    }));
    roleSelect.value = preset.id;
    fillModels(card, saved.model || preset.defaultModel, saved.effort || preset.defaultEffort);
    applyPreset(card, preset, true);
    roleSelect.onchange = () => applyPreset(card, state.presets.find(item => item.id === roleSelect.value));

    card.querySelector('.stop-button').onclick = async () => {
      const runId = card.dataset.runId;
      if (runId) await window.massiveAgents.interrupt(runId);
    };
    grid.append(card);
  }
}

function changeCount(delta) {
  const preferred = snapshotCards();
  state.count = Math.max(1, Math.min(8, state.count + delta));
  $('#agentCount').textContent = state.count;
  renderCards(preferred);
}

function appendOutput(card, text) {
  if (!text) return;
  const output = card.querySelector('.agent-output');
  if (output.textContent === '等待任务…' || output.textContent === '正在启动 Codex 线程…') output.textContent = '';
  output.textContent += text;
  if (output.textContent.length > 18_000) output.textContent = output.textContent.slice(-18_000);
  output.scrollTop = output.scrollHeight;
}

function eventText(event) {
  const params = event.params || {};
  if (typeof params.delta === 'string') return params.delta;
  if (typeof params.text === 'string') return params.text;
  if (typeof params.item?.text === 'string') return params.item.text;
  return '';
}

function handleEvent(event) {
  const card = event.runId ? state.runToCard.get(event.runId) : null;
  if (!card) return;
  appendOutput(card, eventText(event));
  const status = card.querySelector('.agent-status');
  if (event.method === 'turn/started') {
    status.textContent = 'RUNNING';
    status.className = 'agent-status running';
  }
  if (event.method === 'turn/completed') {
    const outcome = event.params?.turn?.status || 'completed';
    status.textContent = String(outcome).toUpperCase();
    status.className = outcome === 'completed' ? 'agent-status done' : 'agent-status error';
    card.querySelector('.stop-button').disabled = true;
  }
}

async function connect() {
  setConnection('', '正在连接 Codex', '启动本地 app-server');
  try {
    const result = await window.massiveAgents.connect();
    if (result.models?.length) {
      const current = snapshotCards();
      state.models = result.models;
      renderCards(current);
    }
    state.connected = true;
    setConnection('connected', 'Codex 已连接', `${state.models.length} 个可用模型`);
  } catch (error) {
    setConnection('error', 'Codex 连接失败', error.message);
    $('#footerStatus').textContent = `连接错误：${error.message}`;
  }
}

async function launch() {
  const button = $('#launchRun');
  button.disabled = true;
  const cards = [...grid.children];
  const config = {
    workspace: $('#workspace').value,
    task: $('#task').value,
    agents: cards.map(currentCardConfig)
  };

  cards.forEach((card, index) => {
    const runId = config.agents[index].runId;
    card.dataset.runId = runId;
    state.runToCard.set(runId, card);
    card.querySelector('.agent-output').textContent = '正在启动 Codex 线程…';
    card.querySelector('.agent-status').textContent = 'STARTING';
    card.querySelector('.agent-status').className = 'agent-status running';
    card.querySelector('.stop-button').disabled = false;
  });

  try {
    if (!state.connected) await connect();
    const results = await window.massiveAgents.launchRun(config);
    results.forEach(result => {
      const card = state.runToCard.get(result.runId);
      if (!card || result.ok) return;
      card.querySelector('.agent-status').textContent = 'ERROR';
      card.querySelector('.agent-status').className = 'agent-status error';
      card.querySelector('.agent-output').textContent = result.error;
      card.querySelector('.stop-button').disabled = true;
    });
    $('#footerStatus').textContent = `已保存并启动 ${results.filter(item => item.ok).length}/${results.length} 个 Agent`;
  } catch (error) {
    $('#footerStatus').textContent = `启动失败：${error.message}`;
    cards.forEach(card => {
      card.querySelector('.agent-status').textContent = 'ERROR';
      card.querySelector('.agent-status').className = 'agent-status error';
      card.querySelector('.stop-button').disabled = true;
    });
  } finally {
    button.disabled = false;
  }
}

async function init() {
  const bootstrap = await window.massiveAgents.bootstrap();
  state.presets = bootstrap.presets;
  state.models = bootstrap.fallbackModels;
  const saved = bootstrap.saved;
  if (saved) {
    $('#workspace').value = saved.workspace || '';
    $('#task').value = saved.task || '';
    state.count = Math.max(1, Math.min(8, saved.agents?.length || 4));
    $('#agentCount').textContent = state.count;
    renderCards(saved.agents || []);
    $('#footerStatus').textContent = '已载入上次本地配置';
  } else {
    renderCards([]);
  }

  $('#minusCount').onclick = () => changeCount(-1);
  $('#plusCount').onclick = () => changeCount(1);
  $('#pickWorkspace').onclick = async () => {
    const selected = await window.massiveAgents.pickWorkspace();
    if (selected) $('#workspace').value = selected;
  };
  $('#launchRun').onclick = launch;
  window.massiveAgents.onEvent(handleEvent);
  window.massiveAgents.onDiagnostic(text => {
    if (/error|failed/i.test(text)) $('#footerStatus').textContent = text.trim().slice(0, 180);
  });
  connect();
}

init().catch(error => {
  setConnection('error', '初始化失败', error.message);
  $('#footerStatus').textContent = error.message;
});
