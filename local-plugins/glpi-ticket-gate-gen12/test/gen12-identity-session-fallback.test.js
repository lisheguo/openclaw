import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlowStore } from '../lib/state.js';
import { handleEntityLookup } from '../lib/handlers.js';
import { createFlowGatedToolFactory } from '../lib/tool.js';

function setup() {
  const store = createFlowStore();
  const logs = [];
  const deps = {
    cfg: { entityListToolId: 'glpi__glpi_list_entities' },
    store,
    log: { info: s => logs.push(s), warn: s => logs.push(s), debug: s => logs.push(s) },
    readSkill: () => ({ ok: true, text: 'test rules', sha256: 'test' }),
  };
  return { store, deps, logs };
}

test('GEN12/R3-B：显式身份优先，不依赖兜底', () => {
  const { store } = setup();
  store.start('group', 'tech-a');
  store.rememberIdentity('group', 'tech-a', 'test');
  assert.deepEqual(store.resolveTrustedSender('group', 'tech-b'), {
    senderId: 'tech-b', source: 'requester',
  });
});

test('GEN12/R3-B：无显式身份时，单 flow 会话兜底命中', () => {
  const { store, deps } = setup();
  store.start('group', 'tech-a');
  // 工具工厂是可信身份来源 → 登记会话身份
  assert.ok(createFlowGatedToolFactory(deps)({ sessionKey: 'group', requesterSenderId: 'tech-a' }));
  const r = store.resolveTrustedSender('group', undefined);
  assert.equal(r.source, 'session');
  assert.equal(r.senderId, 'tech-a');
});

test('GEN12/R3-B：会话内存在他人活跃 flow → 兜底拒绝（无歧义约束，不做错误归属）', () => {
  const { store } = setup();
  store.start('group', 'tech-a');
  store.rememberIdentity('group', 'tech-a', 'test');
  store.start('group', 'tech-b');
  const r = store.resolveTrustedSender('group', undefined);
  assert.equal(r.senderId, null);
  assert.equal(r.source, 'none_session_ambiguous');
});

test('GEN12/R3-B：兜底身份无自有 flow / 身份过期 → fail-closed', () => {
  let t = 1000;
  const store = createFlowStore(2 * 60 * 60 * 1000, () => t, undefined, {}, { ttlMs: 60 * 1000 });
  store.rememberIdentity('group', 'tech-a', 'test');
  assert.equal(store.resolveTrustedSender('group', undefined).source, 'none_no_flow');
  store.start('group', 'tech-a');
  assert.equal(store.resolveTrustedSender('group', undefined).source, 'session');
  t += 61 * 1000;
  const expired = store.resolveTrustedSender('group', undefined);
  assert.equal(expired.senderId, null);
  assert.equal(expired.source, 'none');
});

test('GEN12/R3-B：跨会话不串（兜底仅限本会话）', () => {
  const { store } = setup();
  store.start('group-a', 'tech-a');
  store.rememberIdentity('group-a', 'tech-a', 'test');
  store.start('group-b', 'tech-b');
  assert.equal(store.resolveTrustedSender('group-b', undefined).senderId, null);
});

test('GEN12/R3-B：证据环在兜底身份下可挂（entity_lookup 落 flow）', () => {
  const { store, deps } = setup();
  const a = store.start('group', 'tech-a').flow;
  store.rememberIdentity('group', 'tech-a', 'test');
  const senderId = store.resolveTrustedSender('group', undefined).senderId;
  const r = handleEntityLookup(deps, {
    sessionKey: 'group',
    senderId,
    result: [{ id: 113, name: '客户' }],
    error: null,
  });
  assert.equal(r.recorded, true);
  assert.equal(a.entity_lookup_ok, true);
  assert.deepEqual(a.matched_entity_ids, ['113']);
});

test('GEN12/R3-B：无身份且无兜底 → 维持 fail-closed（NO_OWN_FLOW）', () => {
  const { store, deps, logs } = setup();
  store.start('group', 'tech-a');
  const r = handleEntityLookup(deps, { sessionKey: 'group', senderId: null, result: [], error: null });
  assert.equal(r.recorded, false);
  assert.ok(logs.some(s => s.includes('NO_OWN_FLOW')));
});
