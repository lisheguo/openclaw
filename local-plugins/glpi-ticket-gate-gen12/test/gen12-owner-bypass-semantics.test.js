import test from 'node:test';
import assert from 'node:assert/strict';
import { registerGate } from '../lib/register.js';

// GEN12 / R7-1（2026-10-11 老板批准）：
// 只做"配置 + 显式声明"——不放松任何判定；日志里只记数量，不记 open_id 原文。
function gateLogs(pluginConfig) {
  const logs = [];
  registerGate({
    pluginConfig,
    logger: { info: s => logs.push(s), warn: s => logs.push(s), debug: s => logs.push(s) },
    on: () => {},
    registerTool: () => {},
  });
  return logs;
}

test('R7-1：已配置 ownerSenderIds → 显式声明 CONFIGURED，且不放松判定', () => {
  const logs = gateLogs({ skillPath: '/dev/null', ownerSenderIds: ['ou_owner_fixture_1', 'ou_owner_fixture_2'] });
  const line = logs.find(s => s.includes('event=owner_bypass'));
  assert.ok(line, '必须有 owner_bypass 语义声明行');
  assert.ok(line.includes('decision=CONFIGURED'));
  assert.ok(line.includes('owners=2'));
  assert.ok(line.includes('semantics=NO_TEXT_EXEMPTION'));
  assert.ok(line.includes('judgment_unchanged=true'));
  // 不得把 open_id 写进日志
  assert.ok(!logs.some(s => s.includes('ou_owner_fixture_1')), 'open_id 不得落日志');
  // 旧的含糊告警应消失
  assert.ok(!logs.some(s => s.includes('OWNER_BYPASS_BLOCKED')), '旧告警行应被替换');
});

test('R7-1：未配置 → 明确 NOT_CONFIGURED，语义仍为无话术豁免', () => {
  const logs = gateLogs({ skillPath: '/dev/null' });
  const line = logs.find(s => s.includes('event=owner_bypass'));
  assert.ok(line, '无论是否配置都要显式声明语义');
  assert.ok(line.includes('decision=NOT_CONFIGURED'));
  assert.ok(line.includes('semantics=NO_TEXT_EXEMPTION'));
  assert.ok(line.includes('judgment_unchanged=true'));
});

test('R7-1：空/非法 ownerSenderIds 视为未配置（不产生误报 CONFIGURED）', () => {
  for (const bad of [undefined, [], ['', '   '], 'not-an-array', 123]) {
    const logs = gateLogs({ skillPath: '/dev/null', ownerSenderIds: bad });
    const line = logs.find(s => s.includes('event=owner_bypass'));
    assert.ok(line.includes('decision=NOT_CONFIGURED'), `非法值 ${JSON.stringify(bad)} 应判为未配置`);
  }
});
