import test from 'node:test';
import assert from 'node:assert/strict';
import { hooksHarness } from './support/harness.js';

// Deterministic release barriers, plus actual Promise/microtask/immediate hops.
// There is no timing-based sleep or assumption that a callback has finished.
const orders = [ ['received', 'prompt', 'factory'], ['received', 'factory', 'prompt'],
  ['prompt', 'received', 'factory'], ['prompt', 'factory', 'received'],
  ['factory', 'received', 'prompt'], ['factory', 'prompt', 'received'] ];
async function hop(seed) {
  for (let n = 0; n < seed % 5; n++) {
    if ((seed + n) % 2) await new Promise(resolve => setImmediate(resolve));
    else await new Promise(resolve => queueMicrotask(resolve));
  }
}

test('DEV-04 240 mixed asynchronous/concurrent schedules: safety PASS, first-turn readiness BLOCKED', { concurrency: 12 }, async t => {
  let factoryMisses = 0; let promptMisses = 0;
  const tasks = Array.from({ length: 240 }, (_, i) => t.test(`schedule-${i + 1}`, async () => {
    const h = hooksHarness(); const order = orders[i % orders.length];
    const seen = { a: false, b: false };
    const flows = new Map();
    const release = {}; const done = {};
    const jobs = [];
    for (const who of ['a', 'b']) for (const phase of order) {
      const key = `${who}/${phase}`;
      const ready = new Promise(resolve => { release[key] = resolve; });
      done[key] = (async () => {
          await ready; await hop(i + (who === 'a' ? 1 : 2));
          const ctx = { channelId: 'feishu', sessionKey: 'shared-group', senderId: `tech-${who}`, runId: `run-${who}`, trigger: 'user' }; // Synthetic host context.
          if (phase === 'received') {
            // B is ordinary chat in half the runs, a separate technician in the rest.
            h.emit('message_received', { content: who === 'a' || i % 2 ? '新增工单' : '普通聊天', messageId: `fixture-${who}-${i}` }, ctx);
            seen[who] = who === 'a' || Boolean(i % 2);
          } else if (phase === 'prompt') {
            const [result] = h.emit('before_prompt_build', {}, ctx);
            assert.equal(Boolean(result?.prependContext), seen[who]);
            if (who === 'a' && !result) promptMisses++;
          } else {
            const tool = h.factory({ sessionKey: ctx.sessionKey, requesterSenderId: ctx.senderId });
            assert.equal(Boolean(tool), seen[who]);
            if (who === 'a' && !tool) factoryMisses++;
            if (tool) flows.set(who, tool);
          }
          assert.equal(h.factory({ sessionKey: 'shared-group' }), null);
          assert.equal(h.factory({ sessionKey: 'other-group', requesterSenderId: ctx.senderId }), null);
        })();
      jobs.push(done[key]);
    }
    for (const phase of order) {
      // Two senders run concurrently; only their own phase dependencies are released.
      release[`a/${phase}`](); release[`b/${phase}`]();
      await Promise.all([done[`a/${phase}`], done[`b/${phase}`]]);
    }
    await Promise.all(jobs);
    assert.ok(h.factory({ sessionKey: 'shared-group', requesterSenderId: 'tech-a' }));
  }));
  await Promise.all(tasks);
  assert.equal(factoryMisses, 120);
  assert.equal(promptMisses, 120);
  t.diagnostic(`240 schedules; initial factory missing=${factoryMisses}; initial prompt missing=${promptMisses}; no identity fallback; readiness=BLOCKED`);
});
