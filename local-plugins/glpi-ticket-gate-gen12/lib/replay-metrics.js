// Telemetry only. No timers, callbacks, I/O, receipt eviction or authorization.
export const CAPACITY_WARN_THRESHOLDS = Object.freeze([70, 85, 95, 100]);
const reasons = Object.freeze(["RESERVED", "DUPLICATE_IGNORED", "MESSAGE_ID_CONFLICT", "FLOW_SCOPE_CONFLICT",
  "CAPACITY_BLOCKED", "NO_IDENTITY", "MISSING_MESSAGE_ID", "INVALID_SCOPE", "INVALID_MESSAGE_LINK",
  "NONE", "GENERATION_CLOSED", "IDENTITY_OR_LINK_CONFLICT", "HANDLER_ERROR"]);
const counters = () => Object.fromEntries(reasons.map(reason => [reason, 0]));
const copy = value => Object.freeze({ ...value });
const rejected = reasons.filter(reason => !["RESERVED", "DUPLICATE_IGNORED", "NONE", "HANDLER_ERROR"].includes(reason));
const bucketKey = (owner, scope) => `${owner}/${scope}`;

export function createReplayMetrics(capacity) {
  const total = counters(), unattributed = counters();
  // Only scopes/keys with a business receipt get a metrics index. Rejected new
  // identities cannot grow these Maps. Internal hashes are never returned/logged.
  const scopes = new Map(), receiptScopes = new Map();
  let used = 0, crossed = 0, pending = 0, saturated = false;
  const increment = (target, reason) => {
    if (target[reason] < Number.MAX_SAFE_INTEGER) target[reason]++;
    else saturated = true;
  };
  return Object.freeze({
    record(reason, { key, owner, scope, size } = {}) {
      if (!Object.hasOwn(total, reason)) return;
      const name = owner && scope ? bucketKey(owner, scope) : undefined;
      let bucket = (key ? receiptScopes.get(key) : undefined) ?? scopes.get(name);
      if (reason === "RESERVED") {
        used = size;
        if (!bucket) { bucket = counters(); scopes.set(name, bucket); }
        receiptScopes.set(key, bucket); // Share the bucket; don't retain a scope string per receipt.
        for (let i = 0; i < CAPACITY_WARN_THRESHOLDS.length; i++) {
          const bit = 1 << i;
          if (!(crossed & bit) && used >= Math.ceil(capacity * CAPACITY_WARN_THRESHOLDS[i] / 100)) {
            crossed |= bit; pending |= bit;
          }
        }
      }
      increment(total, reason);
      increment(bucket ?? unattributed, reason);
    },
    snapshot() {
      return Object.freeze({ used, capacity, remaining: capacity - used, scope_count: scopes.size,
        rejected_total: Math.min(Number.MAX_SAFE_INTEGER, rejected.reduce((sum, reason) => sum + total[reason], 0)),
        counters_saturated: saturated, counters: copy(total), unattributed: copy(unattributed) });
    },
    scopeSnapshot(owner, scope) {
      const value = scopes.get(bucketKey(owner, scope));
      return value ? copy(value) : null; // No identifier, hash or enumeration API.
    },
    takeCapacityWarnings() {
      const warnings = [];
      for (let i = 0; i < CAPACITY_WARN_THRESHOLDS.length; i++) if (pending & (1 << i)) {
        warnings.push(Object.freeze({ threshold_pct: CAPACITY_WARN_THRESHOLDS[i], used, capacity, scope_count: scopes.size }));
      }
      pending = 0;
      return warnings;
    },
  });
}

// Called only AFTER guard.run has returned or thrown. Logging failure cannot
// affect its result or repeat the mutation; consumed warnings are not retried.
export function reportReplayCapacity(guard, log) {
  try {
    for (const warning of guard.takeCapacityWarnings()) {
      try {
        log.warn(`mode=shadow event=inbound_replay_capacity threshold_pct=${warning.threshold_pct} used=${warning.used} capacity=${warning.capacity} scope_count=${warning.scope_count}`);
      } catch { /* Best-effort telemetry; do not re-enter business handling. */ }
    }
  } catch { /* Monitoring must not change the original handler outcome. */ }
}
