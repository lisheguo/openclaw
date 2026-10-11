// Rejected admission prototype. Deliberately test-only: registerGate does not
// import this module. v2026.9.9 exposes a rendered cleanedBody, not a separately
// authenticated current-message body/id. Never parse provenance out of prose.
export function inspectFirstTurnAdmission(_event, ctx) {
  if (ctx?.trigger !== 'user') return { handled: false, reason: 'NOT_USER_TURN' };
  for (const field of ['sessionKey', 'senderId', 'runId']) {
    if (typeof ctx?.[field] !== 'string' || !ctx[field].trim()) {
      return { handled: false, reason: 'NO_TRUSTED_TURN_IDENTITY' };
    }
  }
  // Extra event fields supplied by a caller are not an official host contract.
  // Neither ctx.channelContext nor a [message_id: ...] string grants this proof.
  return { handled: false, reason: 'CURRENT_MESSAGE_BOUNDARY_AND_ID_UNAVAILABLE' };
}

export function registerFirstTurnPrototype(api, observe = () => {}) {
  api.on('before_agent_reply', (event, ctx) => {
    const result = inspectFirstTurnAdmission(event, ctx);
    observe(result.reason);
    return result;
  }, { eligibleTriggers: ['user'] });
}
