import { evaluateCreate } from './gate.js';
import { draftHash } from './draft.js';
import { positiveId, priorityInstructionMatches, solutionContentMatches, stableKey, ticketContentMatches, unwrapResult } from './contract.js';

const blocked = reason => ({ would_allow: false, would_block: true, reason });
const allowed = () => ({ would_allow: true, would_block: false, reason: null });
const keysOnly = (p, keys) => Object.keys(p).every(k => keys.includes(k));
const operationKey = (runId, toolCallId) => JSON.stringify([runId, toolCallId]);
const validIdentity = value => typeof value === 'string' && value.trim().length > 0;
const ownFlow = (deps, identity) => validIdentity(identity.sessionKey) && validIdentity(identity.senderId)
  ? deps.store.get(identity.sessionKey, identity.senderId) : null;
const stillAuthorized = (flow, w) => flow.preflight_ok && flow.entity_lookup_ok &&
  priorityInstructionMatches(flow) &&
  String(flow.narrow_entity_id) === String(w.data.entity_id) &&
  flow.draft?.hash === w.draft_hash && draftHash(flow.preflight_data) === w.draft_hash &&
  flow.preview_sent && flow.preview_hash === w.draft_hash && flow.confirmed &&
  flow.confirmed_hash === w.draft_hash && flow.confirmed_by === flow.initiator_sender_id;

export function workflowEvidence(flow) {
  const w = flow?.workflow;
  if (!w) return { phase: 'NO_FLOW', ticket_id: null, next_step: 'NO_ACTIVE_FLOW' };
  let next = 'CREATE_AFTER_CONFIRMED_PREVIEW';
  if (w.phase === 'CREATE_OUTCOME_UNKNOWN') next = 'BLOCKED_RECONCILE_CREATE_OUTCOME_DO_NOT_RECREATE';
  else if ([...w.operations.values()].some(op => !op.done)) next = 'WAIT_FOR_CORRELATED_RESULT';
  else if (w.ticket_id) {
    if (w.solution_unknown) next = 'BLOCKED_RECONCILE_SOLUTION_OUTCOME_DO_NOT_READD';
    else if (w.data.target_status === 2) next = w.last_requested_status === 2 && w.last_status == null
      ? 'READ_BACK_TICKET' : 'REQUEST_STATUS_2_THEN_READ_BACK';
    else if (!w.solution_id) next = 'ADD_CONFIRMED_METHOD_AND_RESULT_AS_SOLUTION_THEN_READ_BACK';
    else if (w.last_status == null) next = 'READ_BACK_TICKET';
    else if ([1, 2, 3, 4].includes(w.last_status)) next = 'BLOCKED_VERIFY_SERVER_TRANSITION_BEFORE_UPDATE_5';
    else if (w.data.target_status === 6 && w.last_status === 5) next = 'BLOCKED_VERIFY_SERVER_TRANSITION_BEFORE_UPDATE_6';
    else next = 'BLOCKED_RECONCILE_OBSERVED_STATE';
    if (!stillAuthorized(flow, w)) next = 'BLOCKED_DRAFT_CHANGED_AFTER_CREATE';
  }
  return { phase: w.phase, ticket_id: w.ticket_id, solution_recorded: w.solution_id != null,
    observed_status: w.last_status, target_status: w.data?.target_status ?? flow.preflight_data?.target_status ?? null,
    transition_runtime_verified: false, next_step: next };
}

function continuationDecision(flow, kind, p) {
  const w = flow.workflow;
  if (!w.ticket_id) return blocked('TICKET_ID_NOT_ESTABLISHED');
  const id = positiveId(kind === 'solution' ? p.ticket_id : p.id);
  if (id !== w.ticket_id) return blocked('TICKET_ID_MISMATCH');
  if (kind === 'read') {
    return keysOnly(p, ['id', 'with_logs']) && (p.with_logs == null || typeof p.with_logs === 'boolean')
      ? allowed() : blocked('READ_PARAMS_UNSUPPORTED');
  }
  if (!stillAuthorized(flow, w)) {
    return blocked('DRAFT_CHANGED_AFTER_CREATE');
  }
  if (kind === 'solution') {
    if (w.data.target_status === 2) return blocked('SOLUTION_NOT_REQUIRED');
    if (w.solution_id) return blocked('SOLUTION_ALREADY_RECORDED');
    if (w.solution_unknown) return blocked('SOLUTION_OUTCOME_UNKNOWN');
    return keysOnly(p, ['ticket_id', 'content', 'solutiontypes_id']) &&
      solutionContentMatches(p.content, w.data) && (p.solutiontypes_id ?? 0) === 0
      ? allowed() : blocked('SOLUTION_CONTENT_MISMATCH');
  }
  if (!keysOnly(p, ['id', 'status']) || ![2, 5, 6].includes(p.status)) return blocked('UPDATE_PARAMS_UNSUPPORTED');
  if (w.data.target_status === 2) return p.status === 2 ? allowed() : blocked('TARGET_STATUS_MISMATCH');
  if (!w.solution_id || w.solution_unknown) return blocked('SOLUTION_REQUIRED');
  if (p.status === 5 && [1, 2, 3, 4].includes(w.last_status)) return allowed();
  if (w.data.target_status === 6 && p.status === 6 && w.last_status === 5 && w.observed_resolved) return allowed();
  return blocked('STATUS_STAGE_NOT_OBSERVED');
}

export function handleWorkflowCheck(deps, input) {
  const { kind, params, runId, toolCallId } = input;
  const flow = ownFlow(deps, input);
  let decision;
  if (!flow) decision = blocked('NO_ACTIVE_TICKET_FLOW');
  else if (!validIdentity(runId) || !validIdentity(toolCallId)) decision = blocked('NO_CALL_CORRELATION');
  else {
    const w = flow.workflow; const key = operationKey(runId, toolCallId);
    if (w.operations.has(key)) decision = blocked('CALL_ALREADY_SEEN');
    else if ([...w.operations.values()].some(op => !op.done)) decision = blocked(w.ticket_id ? 'OPERATION_IN_PROGRESS' : 'CREATE_IN_PROGRESS');
    else if (w.operations.size >= 256) decision = blocked('CALL_CAP_REACHED');
    else if (!params || typeof params !== 'object' || Array.isArray(params)) decision = blocked('INVALID_PARAMS');
    else decision = kind === 'create' ? evaluateCreate(flow, params) : continuationDecision(flow, kind, params);
    if (decision.would_allow) {
      if (!deps.store.bindRun(flow, runId)) decision = blocked('RUN_CONFLICT');
      else {
        w.operations.set(key, { kind, paramsKey: stableKey(params), done: false,
          data: structuredClone(flow.preflight_data), draftHash: flow.draft?.hash, requestedStatus: params.status });
        if (kind === 'create') {
          flow.submissions.set(key, { allowed: true }); w.phase = 'CREATE_IN_PROGRESS';
        } else if (kind === 'solution') { w.phase = 'SOLUTION_IN_PROGRESS'; w.last_status = null; }
        else if (kind === 'update') {
          w.phase = 'UPDATE_IN_PROGRESS'; w.last_requested_status = params.status; w.last_status = null;
        }
      }
    }
  }
  deps.log.info(`mode=shadow event=before_tool_call tool=${kind === 'create' ? 'create_ticket' : kind}` +
    ` decision=${decision.would_allow ? 'WOULD_ALLOW' : 'WOULD_BLOCK'}` + (decision.reason ? ` reason=${decision.reason}` : '') +
    (kind === 'update' ? ' server_transition=UNKNOWN' : ''));
  // WOULD_ALLOW evaluates local authorization/schema only. It neither proves
  // server transition legality nor enables an action; all hooks stay Shadow.
  return { decisions: [decision], shadowAllow: true, transition_runtime_verified: false };
}

export function handleWorkflowResult(deps, input) {
  const { kind, runId, toolCallId, params, result, error } = input;
  const flow = ownFlow(deps, input);
  if (!flow || !validIdentity(runId) || !validIdentity(toolCallId)) return { recorded: false, completed: false };
  const w = flow.workflow; const key = operationKey(runId, toolCallId); const op = w.operations.get(key);
  if (!op || op.done || op.kind !== kind || op.paramsKey !== stableKey(params)) return { recorded: false, completed: false };
  op.done = true; flow.submissions.delete(key);
  const payload = error == null ? unwrapResult(result) : null;
  let completed = false;
  if (kind === 'create') {
    const id = payload?.success === true ? positiveId(payload.id) : null;
    if (id) {
      w.ticket_id = id; w.data = op.data; w.draft_hash = op.draftHash; w.phase = 'CREATED';
    } else w.phase = 'CREATE_OUTCOME_UNKNOWN';
  } else if (kind === 'solution') {
    const id = payload?.success === true ? positiveId(payload.solution_id) : null;
    if (id) { w.solution_id = id; w.phase = 'SOLUTION_RECORDED_NEEDS_READBACK'; }
    else { w.solution_unknown = true; w.phase = 'SOLUTION_OUTCOME_UNKNOWN'; }
  } else if (kind === 'update') {
    // Neither a successful ack nor an error proves the actual status. Re-read;
    // a lost ack may have committed, and repeating create/solution is unsafe.
    w.phase = payload?.success === true && positiveId(payload.id) === w.ticket_id
      ? 'UPDATE_ACK_NEEDS_READBACK' : 'UPDATE_OUTCOME_UNKNOWN_NEEDS_READBACK';
  } else {
    w.last_status = null; w.solution_count = null;
    const valid = payload && payload.success !== false && positiveId(payload.id) === w.ticket_id &&
      [1, 2, 3, 4, 5, 6].includes(payload.status) && Number.isSafeInteger(payload.counts?.solutions) && payload.counts.solutions >= 0 &&
      payload.priority === w.data.priority && String(payload.itilcategories_id) === String(w.data.category_id) &&
      String(payload.entities_id) === String(w.data.entity_id) && payload.name === w.data.title && ticketContentMatches(payload.content, w.data);
    if (!valid) w.phase = 'READBACK_INVALID_OR_CONTENT_MISMATCH';
    else {
      w.last_status = payload.status; w.solution_count = payload.counts.solutions; w.phase = 'STATE_OBSERVED';
      const solution = w.solution_id != null && payload.counts.solutions > 0 && !w.solution_unknown;
      if (solution && payload.status === 5) w.observed_resolved = true;
      completed = stillAuthorized(flow, w) && (w.data.target_status === 2
        ? payload.status === 2 && w.last_requested_status === 2
        : w.data.target_status === 5 ? payload.status === 5 && solution
          : payload.status === 6 && solution && w.observed_resolved && w.last_requested_status === 6);
      if (completed) { w.phase = 'TARGET_VERIFIED'; deps.store.complete(flow); }
    }
  }
  deps.log.info(`mode=shadow event=workflow_result tool=${kind} phase=${w.phase} completed=${completed}`);
  return { recorded: true, created: kind === 'create' && w.ticket_id != null, completed, phase: w.phase };
}
