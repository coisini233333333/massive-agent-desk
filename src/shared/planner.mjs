import { presetById } from './agent-presets.mjs';

const MAX_AGENTS = 8;

export function buildRunPlan({ task, workspace, agents }) {
  const cleanTask = String(task ?? '').trim();
  const cleanWorkspace = String(workspace ?? '').trim();

  if (!cleanTask) throw new Error('请输入任务。');
  if (!cleanWorkspace) throw new Error('请选择工作目录。');
  if (!Array.isArray(agents)) throw new Error('Agent 配置无效。');

  const enabled = agents.filter(agent => agent.enabled !== false);
  if (enabled.length < 1) throw new Error('至少启用一个 Agent。');
  if (enabled.length > MAX_AGENTS) throw new Error(`首版最多并发 ${MAX_AGENTS} 个 Agent。`);

  const ids = new Set();
  return enabled.map((agent, index) => {
    const preset = presetById(agent.presetId);
    if (!preset) throw new Error(`未知 Agent 预设：${agent.presetId}`);
    const runId = agent.runId || `${preset.id}-${index + 1}`;
    if (ids.has(runId)) throw new Error(`Agent 标识重复：${runId}`);
    ids.add(runId);

    const model = String(agent.model || preset.defaultModel);
    const effort = String(agent.effort || preset.defaultEffort);
    const rolePrompt = String(agent.instructions || preset.instructions).trim();

    return {
      runId,
      presetId: preset.id,
      label: agent.label || preset.label,
      model,
      effort,
      cwd: cleanWorkspace,
      prompt: [
        rolePrompt,
        '',
        '本次任务：',
        cleanTask,
        '',
        '协作要求：你是并行工作流中的一个独立 lane。只负责与你的角色直接相关的部分；不要假设其他 Agent 的输出。最终返回：结论、证据或改动路径、验证结果、未决风险、给主 Agent 的下一步。'
      ].join('\n')
    };
  });
}

export function extractEventText(message) {
  if (!message || typeof message !== 'object') return '';
  const params = message.params || {};
  if (typeof params.delta === 'string') return params.delta;
  if (typeof params.text === 'string') return params.text;
  const item = params.item || {};
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  return '';
}
