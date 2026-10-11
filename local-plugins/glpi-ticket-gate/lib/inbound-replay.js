import { createHash } from "node:crypto";
import { createReplayMetrics } from "./replay-metrics.js";

// Receipts last for this store's whole in-process lifetime, independently of
// Flow TTL/completion. Exhaustion denies mutation; nothing is evicted/reset.
export const INBOUND_RECEIPT_CAPACITY = 4096;
const identityFields = ["channelId", "accountId", "conversationId", "sessionKey", "senderId", "messageId"];
const replyFields = ["replyToId", "replyToIdFull", "replyToBody", "replyToSender", "replyToIsQuote", "threadId"];
const present = value => value !== undefined && value !== null;
const id = value => typeof value === "string" && Boolean(value.trim()) && value.length <= 4096;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const failure = decision => ({ decision });

// Only structured host projections. Metadata/from/display names/body IDs are
// never identity sources. Channel/account/conversation authority is context-only
// in the fixed message_received SDK; unexpected event copies cannot override it.
export function projectInboundMessage(event, ctx) {
  const input = { text: event?.content };
  for (const field of [...identityFields, ...replyFields]) {
    const a = event?.[field], b = ctx?.[field];
    if (present(a) && present(b) && a !== b) return failure("IDENTITY_OR_LINK_CONFLICT");
    if (["channelId", "accountId", "conversationId"].includes(field)) {
      if (present(a) && a !== b) return failure("IDENTITY_OR_LINK_CONFLICT");
      input[field] = b;
    } else input[field] = a ?? b;
  }
  if (present(event?.channel) && event.channel !== input.channelId) return failure("IDENTITY_OR_LINK_CONFLICT");
  return { input: Object.freeze(input) };
}

function validate(input) {
  if (!["channelId", "sessionKey", "senderId"].every(field => id(input[field]))) return "NO_IDENTITY";
  if (!id(input.messageId)) return "MISSING_MESSAGE_ID";
  if (["accountId", "conversationId"].some(field => present(input[field]) && !id(input[field]))) return "INVALID_SCOPE";
  if (typeof input.text !== "string" || !input.text.trim()) return "NONE";
  for (const field of replyFields) {
    const value = input[field];
    if (!present(value)) continue;
    if (field === "replyToIsQuote" ? typeof value !== "boolean"
      : field === "threadId" ? !(typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))
        : typeof value !== "string") return "INVALID_MESSAGE_LINK";
  }
  return null;
}

export function createInboundReplayGuard({ capacity = INBOUND_RECEIPT_CAPACITY } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new TypeError("Invalid inbound receipt capacity");
  const receipts = new Map(); const ownerScopes = new Map(); let closed = false;
  const metrics = createReplayMetrics(capacity);
  const note = (reason, context) => { try { metrics.record(reason, context); } catch { /* telemetry only */ } };
  const deny = (reason, context) => { note(reason, context); return failure(reason); };
  return Object.freeze({
    run(input, mutate) {
      if (closed) return deny("GENERATION_CLOSED");
      const snapshot = Object.freeze(Object.fromEntries(["text", ...identityFields, ...replyFields].map(field => [field, input[field]])));
      const invalid = validate(snapshot);
      if (invalid) return deny(invalid);
      const key = hash(identityFields.map(field => snapshot[field] ?? null));
      const digest = hash([snapshot.text, ...replyFields.map(field => snapshot[field] ?? null)]);
      const prior = receipts.get(key);
      if (prior) return deny(prior.digest === digest ? "DUPLICATE_IGNORED" : "MESSAGE_ID_CONFLICT", { key });
      // Existing Flow identity is (session,sender). Fail closed if two channel/
      // account/conversation scopes collide there, instead of mutating that Flow.
      const owner = hash([snapshot.sessionKey, snapshot.senderId]);
      const scope = hash([snapshot.channelId, snapshot.accountId ?? null, snapshot.conversationId ?? null]);
      if (ownerScopes.has(owner) && ownerScopes.get(owner) !== scope) return deny("FLOW_SCOPE_CONFLICT", { owner, scope });
      if (receipts.size >= capacity) return deny("CAPACITY_BLOCKED", { owner, scope });
      // Register BEFORE any callback/Flow access. Reentrant calls see the same
      // receipt, including if mutate throws. Conflicts never replace its digest.
      receipts.set(key, Object.freeze({ digest })); ownerScopes.set(owner, scope);
      note("RESERVED", { key, owner, scope, size: receipts.size });
      try { return mutate(snapshot); } // Synchronous handleInbound implementation only.
      catch (error) { note("HANDLER_ERROR", { key }); throw error; }
    },
    size: () => receipts.size,
    close: () => { closed = true; }, // No reopening/eviction API; actual host reload is a separate owner.
    metrics: () => metrics.snapshot(),
    scopeMetrics(input) {
      // Caller supplies the structured host scope; reads never allocate buckets
      // or alter counters. O(1) in number of retained receipts, bounded ID input.
      if (!input || !["channelId", "sessionKey", "senderId"].every(field => id(input[field])) ||
        ["accountId", "conversationId"].some(field => present(input[field]) && !id(input[field]))) return null;
      return metrics.scopeSnapshot(hash([input.sessionKey, input.senderId]), hash([input.channelId, input.accountId ?? null, input.conversationId ?? null]));
    },
    recordProjectionConflict: () => note("IDENTITY_OR_LINK_CONFLICT"),
    takeCapacityWarnings: () => metrics.takeCapacityWarnings(),
  });
}
