/* global reviewWindow */
const $ = selector => document.querySelector(selector);
let spec;
let submitting = false;

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = content;
  return node;
}

function render(value) {
  spec = value;
  document.title = value.title;
  $('#title').textContent = value.title;
  const context = $('#context');
  context.replaceChildren();
  for (const [label, content] of value.context) {
    context.append(element('dt', label), element('dd', content));
  }
  $('#exactText').textContent = value.text;
  const choices = $('#choices');
  choices.replaceChildren();
  for (const choice of value.choices) {
    const button = element('button', choice.label, choice.value === value.cancelValue ? 'button secondary' : 'button primary');
    button.type = 'button';
    button.dataset.value = choice.value;
    button.addEventListener('click', () => choose(choice.value));
    choices.append(button);
  }
}

async function choose(value) {
  if (submitting) return;
  submitting = true;
  document.querySelectorAll('.button').forEach(button => { button.disabled = true; });
  $('#status').textContent = '正在提交你的决定…';
  try {
    await reviewWindow.choose(value);
  } catch (error) {
    submitting = false;
    document.querySelectorAll('.button').forEach(button => { button.disabled = false; });
    $('#status').textContent = `无法提交：${error.message}`;
  }
}

$('#copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(spec.text);
    $('#copy').textContent = '已复制';
    setTimeout(() => { $('#copy').textContent = '复制原文'; }, 1200);
  } catch {
    $('#status').textContent = '当前系统不允许复制，请直接选择原文。';
  }
});

reviewWindow.load().then(render).catch(error => {
  $('#title').textContent = '无法加载审阅内容';
  $('#status').textContent = error.message;
});
