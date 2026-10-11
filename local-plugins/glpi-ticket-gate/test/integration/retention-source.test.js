import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { dispatchFixtureSource } from './dispatch-loader.js';

const u = await dispatchFixtureSource();
const { createDedupeCache } = await u.load('src/infra/dedupe.ts');
const { parseStrictNonNegativeInteger } = await u.load('packages/normalization-core/src/number-coercion.ts');
const { buildChannelInboundEventContext } = await u.load('src/channels/inbound-event/context.ts');
const { deriveInboundMessageHookContext, toPluginMessageReceivedEvent } = await u.load('src/hooks/message-hook-mappers.ts');
const lock = JSON.parse(readFileSync(new URL('./source-lock.json', import.meta.url)));
const read = file => {
  const text = readFileSync(path.join(process.env.OPENCLAW_SOURCE, file), 'utf8');
  assert.equal(createHash('sha256').update(text).digest('hex'), lock.files[file]); return text;
};

test('RETENTION-S01 official memory cache loses protection at size or 24h TTL (not durable business dedup)', () => {
  const day = 24 * 60 * 60 * 1000; const cache = createDedupeCache({ ttlMs: day, maxSize: 1000 });
  for (let i = 0; i < 1001; i++) assert.equal(cache.check(`fixture-${i}`, 1), false);
  assert.equal(cache.size(), 1000); assert.equal(cache.peek('fixture-0', 1), false);
  assert.equal(cache.peek('fixture-1000', day), true); assert.equal(cache.peek('fixture-1000', day + 1), false);
  // This executes the memory component only; persistent store fallback is source-audited.
});

test('RETENTION-S02 fixed Feishu producer explicitly falls back to local time; numeric parser is not provenance', () => {
  assert.match(read('extensions/feishu/src/bot.ts'), /parseStrictNonNegativeInteger\(event\.message\.create_time\) \?\? Date\.now\(\)/);
  assert.equal(parseStrictNonNegativeInteger('1700000000000'), 1700000000000);
  for (const value of [undefined, 'not-a-time', '-1']) assert.equal(parseStrictNonNegativeInteger(value), undefined);
  assert.equal(parseStrictNonNegativeInteger('0'), 0);
  // Source fact + actual parser behavior, not execution/authentication of bot.ts.
});

test('RETENTION-S03 official builder/finalizer/mapper expose timestamp value without its creation/fallback provenance', () => {
  const eventFor = timestamp => toPluginMessageReceivedEvent(deriveInboundMessageHookContext(buildChannelInboundEventContext({
    channel: 'feishu', accountId: 'fixture-account', messageId: 'fixture-message', timestamp, from: 'fixture-from',
    sender: { id: 'fixture-sender' }, conversation: { kind: 'group', id: 'fixture-chat', label: 'fixture-group' },
    route: { agentId: 'fixture-agent', routeSessionKey: 'fixture-session', accountId: 'fixture-account' },
    reply: { to: 'fixture-chat' }, message: { body: 'ordinary', rawBody: 'ordinary', commandBody: 'ordinary' },
  })));
  const creation = eventFor(1700000000000), receivedFallback = eventFor(1700000000000);
  assert.equal(JSON.stringify(creation), JSON.stringify(receivedFallback));
  assert.equal(creation.timestamp, 1700000000000); assert.equal(eventFor(undefined).timestamp, undefined);
  assert.equal(eventFor(Number.NaN).timestamp, undefined);
  assert.equal(eventFor(-1).timestamp, -1); // Mapper checks finite number, not trusted age/domain.
});

test('RETENTION-S04 fixed SDK bounded retention, async dedupe and deprecated sync storage contracts', () => {
  const state = read('extensions/feishu/src/dedup-state.ts');
  assert.match(state, /MEMORY_MAX_SIZE = 1_000/); assert.match(state, /STORE_MAX_ENTRIES = 10_000/);
  assert.match(state, /DEDUP_TTL_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(read('src/plugin-sdk/persistent-dedupe.types.ts'), /Promise<ClaimableDedupeClaimResult>/);
  assert.match(read('src/plugin-sdk/persistent-dedupe.ts'), /onDiskError\?\.\(error\);/);
  assert.ok(read('src/plugins/runtime/types-core.ts').includes('openSyncKeyedStore'));
  assert.ok(read('src/plugins/registry-runtime.ts').includes('assertTrustedPluginRuntime("openSyncKeyedStore")'));
  assert.ok(read('src/plugin-state/plugin-state-store.ts').includes('@deprecated Plugin runtimes should use api.runtime.state.openKeyedStore'));
  assert.ok(read('src/plugin-state/plugin-store-validation.ts').includes('value === undefined || value === "evict-oldest"'));
  assert.match(read('extensions/feishu/src/feishu-ingress.ts'), /nestedHeader\?\.event_id/);
  assert.match(read('extensions/feishu/src/dedupe-key.ts'), /"text-retry", senderId, chatId, createTime, contentHash/);
  const doc = read('docs/plugins/sdk-channel-plugins/durable-ingress.md');
  assert.ok(doc.includes('TTL and cap both prune rows')); assert.ok(doc.includes('at-least-once crash window'));
  // These assertions validate pinned audit bytes, not real SQLite/Gateway behavior.
});
