import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunPlan, extractEventText } from '../src/shared/planner.mjs';

test('buildRunPlan produces independent role prompts', () => {
  const plan = buildRunPlan({
    task: '分析论文并实现最小原型',
    workspace: 'G:\\work',
    agents: [
      { runId: 'research', presetId: 'research_scout', model: 'gpt-5.6-luna', effort: 'medium' },
      { runId: 'build', presetId: 'software_builder', model: 'gpt-5.6-terra', effort: 'high' }
    ]
  });

  assert.equal(plan.length, 2);
  assert.equal(plan[0].cwd, 'G:\\work');
  assert.match(plan[0].prompt, /research_scout/);
  assert.match(plan[1].prompt, /software_builder/);
  assert.match(plan[1].prompt, /分析论文并实现最小原型/);
});

test('buildRunPlan rejects empty and oversized runs', () => {
  assert.throws(() => buildRunPlan({ task: '', workspace: 'G:\\work', agents: [] }), /请输入任务/);
  assert.throws(() => buildRunPlan({
    task: 'x',
    workspace: 'G:\\work',
    agents: Array.from({ length: 9 }, (_, index) => ({ runId: String(index), presetId: 'software_builder' }))
  }), /最多并发 8/);
});

test('buildRunPlan rejects duplicate run identifiers', () => {
  assert.throws(() => buildRunPlan({
    task: 'x',
    workspace: 'G:\\work',
    agents: [
      { runId: 'same', presetId: 'research_scout' },
      { runId: 'same', presetId: 'scientific_reasoner' }
    ]
  }), /标识重复/);
});

test('extractEventText accepts delta and completed item shapes', () => {
  assert.equal(extractEventText({ params: { delta: 'abc' } }), 'abc');
  assert.equal(extractEventText({ params: { item: { text: 'done' } } }), 'done');
  assert.equal(extractEventText(null), '');
});
