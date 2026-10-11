import { createHash } from 'node:crypto';
import { isTicketIntent, isConfirmation, parsePriorityDirective } from '../../lib/detect.js';

// TEST-ONLY admission ledger. It has no FlowStore reference and cannot authorize
// preflight, confirmation, tool exposure or a GLPI operation. No production import.
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const valid = value => typeof value === 'string' && value.trim() && value.length <= 512;
function agree(a, b) {
  if (a !== undefined && b !== undefined && a !== b) return undefined;
  const value = a ?? b;
  return valid(value) ? value : undefined;
}
export function dispatchIdentity(event, ctx) {
  const fields = {
    channel: agree(event?.channel, ctx?.channelId),
    session: agree(event?.sessionKey, ctx?.sessionKey),
    sender: agree(event?.senderId, ctx?.senderId),
    message: agree(event?.messageId, ctx?.messageId),
    account: ctx?.accountId,
    conversation: ctx?.conversationId,
  };
  if (fields.channel !== 'feishu' || !Object.values(fields).every(valid)) return null;
  // The dispatch contract duplicates these optional reply fields. Conflicting
  // copies are rejected even though reply text itself never authorizes anything.
  for (const field of ['replyToId', 'replyToIdFull', 'replyToBody', 'replyToSender', 'replyToIsQuote']) {
    if (event?.[field] !== undefined && ctx?.[field] !== undefined && event[field] !== ctx[field]) return null;
  }
  return { key: hash(Object.values(fields)), scope: hash([fields.channel, fields.account, fields.session, fields.sender, fields.conversation]) };
}

export function createDispatchPreparation({ limit = 256, ttlMs = 7200000, now = Date.now } = {}) {
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('Invalid ledger bounds');
  const records = new Map(); const handles = new WeakMap(); let closed = false;
  const sweep = () => {
    for (const record of records.values()) if (record.phase === 'PREPARED' && now() >= record.expires) record.phase = 'TOMBSTONE';
  };
  return {
    prepare(event, ctx) {
      if (closed) return { decision: 'GENERATION_CLOSED' };
      const identity = dispatchIdentity(event, ctx);
      if (!identity || typeof event?.content !== 'string' || !event.content.trim()) return { decision: 'INVALID_HOST_INPUT' };
      sweep();
      // Content is only checked AFTER host ID equality. It never supplies an ID.
      const digest = hash([event.content, event.replyToId ?? ctx.replyToId ?? null, event.replyToIdFull ?? ctx.replyToIdFull ?? null]);
      const prior = records.get(identity.key);
      if (prior) {
        if (prior.digest !== digest) {
          prior.phase = 'CONFLICT';
          return { decision: 'MESSAGE_ID_CONFLICT' };
        }
        return { decision: 'DUPLICATE', phase: prior.phase, receipt: prior.receipt };
      }
      // Never evict a tombstone to make a replay look new. Capacity exhaustion
      // denies new preparation for this generation. TTL retires, not forgets.
      if (records.size >= limit) return { decision: 'CAPACITY_BLOCKED' };
      const receipt = Object.freeze({});
      // These are lexical candidates only: the official mapper can fall back
      // to rendered Body when command/raw projections are blank. The public
      // event does not expose which projection supplied content.
      const record = { ...identity, digest, phase: 'PREPARED', expires: now() + ttlMs, receipt,
        intent: isTicketIntent(event.content), confirmation: isConfirmation(event.content),
        priority: parsePriorityDirective(event.content) };
      records.set(identity.key, record); handles.set(receipt, record);
      return { decision: 'PREPARED_NOT_ADMITTED', receipt };
    },
    observe() { return { decision: 'READ_ONLY_OBSERVATION' }; },
    retire(receipt) {
      const record = handles.get(receipt);
      if (!record || closed) return false;
      record.phase = 'TOMBSTONE';
      return true;
    },
    snapshot(receipt) {
      const r = handles.get(receipt);
      return r ? { phase: r.phase, scope: r.scope, digest: r.digest, intent: r.intent,
        confirmation: r.confirmation, priority: r.priority } : null;
    },
    size: () => records.size,
    close() { closed = true; for (const r of records.values()) r.phase = 'TOMBSTONE'; },
    resolveAdmittedRun() {
      // before_dispatch has no runId or content-projection provenance. Later
      // Factory/Agent hook contracts lack the native message ID. No guessing.
      return { ready: false, reason: 'HOST_MESSAGE_TO_ADMITTED_RUN_LINK_UNPROVEN' };
    },
  };
}

export function registerDispatchPrototype(api, ledger, observe = () => {}) {
  api.on('before_dispatch', (event, ctx) => {
    observe(ledger.prepare(event, ctx));
    return { handled: false };
  });
  api.on('message_received', () => ledger.observe()); // Sole entry above changes preparation only.
}
