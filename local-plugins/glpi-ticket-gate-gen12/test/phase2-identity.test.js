import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlowStore } from '../lib/state.js';
import { handlePromptBuild } from '../lib/handlers.js';
import { createFlowGatedToolFactory } from '../lib/tool.js';

function setup() {
  const store = createFlowStore();
  const a = store.start('group', 'tech-a').flow;
  const logs = [];
  const deps = { store, log: { info: s => logs.push(s), warn: s => logs.push(s) },
    readSkill: () => ({ ok: true, text: 'test rules', sha256: 'test' }) };
  return { store, a, deps, logs };
}
test('DEV-02 prompt/Factory 仅本人 Flow，群内他人、无身份与非用户回合不注入', () => {
  const { store, a, deps } = setup();
  for (const senderId of [undefined, '', 'tech-b']) {
    assert.equal(handlePromptBuild(deps, { sessionKey: 'group', senderId }).injected, false);
    assert.equal(createFlowGatedToolFactory(deps)({ sessionKey: 'group', requesterSenderId: senderId }), null);
  }
  const b = store.start('group', 'tech-b').flow;
  for (const [senderId, expected] of [['tech-a', a], ['tech-b', b]]) {
    assert.equal(handlePromptBuild(deps, { sessionKey: 'group', senderId, runId: senderId }).flow, expected);
  }
  assert.equal(handlePromptBuild(deps, { sessionKey: 'group', senderId: 'tech-a', trigger: 'cron' }).injected, false);
  assert.equal(handlePromptBuild(deps, { sessionKey: 'other', senderId: 'tech-a' }).injected, false);
});
test('DEV-02 run 绑定拒绝跨用户冲突且过期/完成后不可复用', () => {
  const { store, a, deps } = setup();
  store.start('group', 'tech-b');
  assert.equal(handlePromptBuild(deps, { sessionKey: 'group', senderId: 'tech-a', runId: 'run-a' }).injected, true);
  assert.equal(handlePromptBuild(deps, { sessionKey: 'group', senderId: 'tech-b', runId: 'run-a' }).injected, false);
  assert.equal(store.getByRun('group', 'run-a'), a);
  store.complete(a);
  assert.equal(store.getByRun('group', 'run-a'), null);
});
test('DEV-02 Skill 读取错误只记固定原因，不泄露路径或错误内容', () => {
  const { deps, logs } = setup();
  deps.readSkill = () => ({ ok: false, error: 'private-source-secret' });
  assert.equal(handlePromptBuild(deps, { sessionKey: 'group', senderId: 'tech-a' }).injected, false);
  assert.equal(logs.join('').includes('private-source-secret'), false);
});
