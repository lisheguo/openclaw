# CHG-GLPI-PHASE2-P0-001-CODEX

Latest follow-up: [FIRST-TURN-001 audit and rejected prototype](../first-turn-001/REPORT.md). Baseline 438/438; unit tests 448/448 and official component tests 16/16. The early awaited Hook lacks a reliable current-message body/ID contract; no prototype was activated. DEV-04 remains BLOCKED; complete Runner and real reload acceptance were not executed. The 438-test delivery below is historical.

Previous follow-up: [Parent-reviewed complete Skill contract](skill-contract-reviewed.md). The parent inspected the REVIEWED archive and supplied vetted contract text; this Codex environment did not download the ZIP. Solution content now requires method plus result, category is a required derived field (1–8), and non-default priority (1–5) needs an explicit initiator directive. The full-format evidence gap is resolved; runtime delivery/GLPI behavior and the independent BLOCKED items remain. Prior [contract](contract-6060561318.md) and [review](review-5455706508.md) reports preserve earlier evidence stages.

```text
TASK_ID=CHG-GLPI-PHASE2-P0-001-CODEX
REPO=lisheguo/glpi-ticket-gate
BASE_COMMIT=0fb25894232309f8dd28192a6bb1acff26c39d05
DEVELOPMENT_BRANCH=codex/chg-glpi-phase2-p0-001
IMPLEMENTATION_STATUS=PARTIAL
DEV_01_STATUS=PASS (offline)
DEV_02_STATUS=PARTIAL (trusted sender isolation PASS; sender-less Webchat BLOCKED)
DEV_03_STATUS=PASS (offline; host requester required, no inferred fallback)
DEV_04_STATUS=BLOCKED (240 schedules reproduce first-turn readiness gaps)
DEV_05_STATUS=PARTIAL (bound preview/self-confirmation PASS offline; outbound correlation and boss exception BLOCKED)
BASELINE_TESTS=96/96 PASS
FINAL_TESTS=438/438 PASS (425 complete-Skill baseline + 13 additions; original 240 timing cases retained)
TEST_FAILURES=0 final; no skipped/cancelled/todo
SECURITY_BOUNDARY=SHADOW_ONLY; no production access, no actual blocking
UNRESOLVED_RUNTIME_FACTS=actual runtime formatting/transitions, default assignee/get_user evidence, entity/completion-reply limits and prerequisites below; full Skill contract received via parent
DEPLOYMENT_STATUS=NOT_DEPLOYED
ENFORCE_STATUS=NOT_IMPLEMENTED
PR_URL=recorded in final delivery and PR description
ROLLBACK_INSTRUCTIONS=reviewed revert of this branch's commits; no production action performed
NEXT_STEP=review draft only; resolve BLOCKED items in separately authorized work before deployment
```

## Scope and baseline

Source of requirements: [Issue #2](https://github.com/lisheguo/glpi-ticket-gate/issues/2), latest body updated **2026-10-08 10:44:26 UTC**, read at task start and rechecked before publication. Local initial `work` HEAD and remote main both matched the base above. Worktree was clean. No `AGENTS.md` at repository/ancestor locations, no checkout `.agents/skills`, and no available workspace skill instructions for this repository. No unrelated files or existing changes were overwritten. Existing draft PR #1 remains untouched; its broader entity refactor was not imported. Main already contains gen10/gen11, so this branch builds on them.

Node.js `v24.19.0`; no dependency installation was needed. Before editing, `node --test` passed all **96** original cases (README's older 63/84 counts were stale). [Baseline output](baseline-tests.txt). The initial delivery command was `node --test --experimental-test-coverage test/*.test.js`: **357/357**, line coverage **93.74%**, branch coverage **85.36%**. [Initial output](final-tests.txt). The review follow-up passes **363/363**, line coverage **93.81%**, branch coverage **85.91%**; [historical output](review-final-tests.txt) and [follow-up details](review-5455706508.md) distinguish fixed P1 tests from still-BLOCKED P0 reproductions. The contract follow-up baseline was 363/363 and final result is **425/425**, source line coverage **94.96%**, branch **89.18%**; see [previous output](contract-final-tests.txt). The complete-Skill follow-up baseline is 425/425 and final result **438/438**, source line coverage **95.15%**, branch **89.61%**; [current output](skill-contract-final-tests.txt). `node --check` passed for every plugin JS file and `index.ts`; `git diff --check` passed. Syntax checking does not load the actual OpenClaw SDK. Registered hook tests use the real `registerGate` code with a fake host API and synthetic data.

## Fixed-source audit: facts, inference, and gaps

Verified tag objects and peeled commits via `git ls-remote`:

| Version | Tag object | Source commit |
| --- | --- | --- |
| v2026.9.8 | b1c1c6d3af1f68bc82efbb6c92fb224c36df8683 | fc23bc864e4553c2d215e479eeec47b67a0bf943 |
| v2026.9.9 | a5a5dcfb0d5d56ebdedc6a572d8b59fcab15ce12 | bcfc88812a35243893585dbeca87ca41b48272ca |

All ten requested files were downloaded from those commit URLs and compared byte-for-byte. [SHA-256 inventory](source-hashes.txt) makes the comparison reproducible. They were read under `/tmp` only, never installed or edited as Core.

The following links are pinned to **v2026.9.9's commit**, not moving main. To inspect the predecessor, replace the commit segment with the v2026.9.8 commit above.

| Requested source | 9.8 → 9.9 | Confirmed source fact / implication |
| --- | --- | --- |
| [gateway-client-identity.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/gateway/server-methods/gateway-client-identity.ts) | identical | `resolveChatSendCallerContext` conditionally omits ordinary SenderId fields for operator UI/synthetic clients. Profile/command authority elsewhere is not automatically a plugin sender. No display-name/from/session inference allowed. |
| [message-hook-mappers.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/hooks/message-hook-mappers.ts) | identical | Inbound event/context sender is projected from SenderId. Sent event carries success/message/session/run fields when provided. Conflicting event/context copies are denied by this plugin. |
| [message-received-hooks.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/auto-reply/reply/message-received-hooks.ts) | identical | `emitMessageReceivedHooks` returns void and uses fireAndForgetHook. It does not establish an awaited barrier before tool construction. |
| [hook-types.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/plugins/hook-types.ts) | identical | Agent sender/run are optional. Tool `requester.senderId` and `requester.senderIsOwner` are host-derived; absent required identity means fail closed. No authorization from legacy top-level aliases. |
| [hook-agent-context.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/plugins/hook-agent-context.ts) | identical | Sender identity is derived from runtime inputs; non-user triggers are treated separately. This plugin explicitly rejects non-user trigger injection. |
| [hook-before-agent-start.types.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/plugins/hook-before-agent-start.types.ts) | identical | Prompt event has currentUserMessage/currentUserMessageId and toolsAllow. These do not make an earlier Factory asynchronous or prove sender when absent. No prompt-text identity extraction is introduced. |
| [agent-hook-context.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/agents/embedded-agent-runner/run/agent-hook-context.ts) | identical | Runtime runId/sessionKey/sender fields are assembled for agent hooks. Run bindings in this plugin only arise from host context. |
| [attempt-prompt-build.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/agents/embedded-agent-runner/run/attempt-prompt-build.ts) | identical | Prompt/history/context projection is not an inbound-hook completion barrier. No new 9.9 ordering guarantee found. |
| [attempt-before-agent-run.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/agents/embedded-agent-runner/run/attempt-before-agent-run.ts) | changed | Before-agent-run gate and blocked-message construction were extracted into a shared harness helper. Sender/run inputs and block persistence remain explicit; no ordering fix for this plugin. |
| [tool-types.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/plugins/tool-types.ts) | identical | Factory is synchronous and may return null; requesterSenderId is trusted and optional. No guaranteed Factory runId. Invocation-current guard is optional for v1 and required by v2 descriptors. |

The new [before-agent-run helper](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/agents/harness/before-agent-run.ts) clones messages, catches failure as a block decision, and constructs redacted blocked input. This branch does **not** register or enable any blocking hook.

Additional critical source: [hook-message.types.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/plugins/hook-message.types.ts) explicitly warns that outbound runId is not guaranteed through delivery and session-only correlation cannot disambiguate concurrent turns. The mapper can copy a supplied runId; that does not establish its presence on an actual delivery route. Therefore missing outbound runId remains **BLOCKED**, including a unique active Flow.

[attempt.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/agents/embedded-agent-runner/run/attempt.ts) prepares tools before the execution phase. [attempt-tool-prepare.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/agents/embedded-agent-runner/run/attempt-tool-prepare.ts) constructs the initial tool surface; [attempt-prompt-support.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/agents/embedded-agent-runner/run/attempt-prompt-support.ts) applies prompt policy to an already-built baseline. [plugins/tools.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/plugins/tools.ts) resolves synchronous factories and handles null. **Inference:** creating Flow only in a later prompt callback cannot guarantee initial Factory availability. No sleep, Core patch, speculative schema exposure or invented identity was used to mask this gap.

## Implementation and file-level review

Commits are ordered DEV-01 through DEV-05; documentation follows. Inspect each with `git show <commit> -- <path>`, or the draft PR's Files changed tab. Full branch diff: `git diff 0fb25894232309f8dd28192a6bb1acff26c39d05..HEAD`.

| File | Change |
| --- | --- |
| `lib/detect.js` | Explicit 新建/新增加 intents, discussion/negation exclusions; final-preview shape only; confirmation no longer accepts arbitrary prose containing a keyword. Legacy fill-in parser retained but no longer authorizes. |
| `index.ts`, `lib/register.js` | Thin SDK entry plus testable real registration; exact event/context identity agreement; tool hooks use only host requester; new shadow-only preflight-call binding. |
| `lib/handlers.js` | Own sender/session injection and evidence; remove unique/first Flow fallback and cross-person owner confirmation; preflight/run/call binding; strict sent-success and exact current preview; self-confirmation only. |
| `lib/state.js` | Preserve in-memory TTL=2h and per-sender Flow isolation; add bounded run/call associations and draft hashes. Each association map is capped at 256 per Flow, then denies new bindings until completion/expiry. |
| `lib/tool.js` | Snapshot the Flow at Factory creation; retained tools cannot write replacement Flow; optional host invocation guard checked; return canonical final preview and creation body. |
| `lib/draft.js` | Canonical seven fields plus title/entity, SHA-256 draft fingerprint, fresh opaque confirmation code, invalidation and deterministic rendering. No credentials, persistence or API calls. |
| `lib/gate.js` | Keep entity extraction/diagnostics and Shadow return behavior; additionally require draft/preview/confirmation equality and submitted title/three-section body/assignee/entity/creation options; unsupported create.status is rejected, target status belongs to workflow. |
| `lib/log.js` | Hash sender/session instead of exposing prefixes/suffixes; fixed error codes avoid raw exception/config content. |
| `test/gate.test.js` | Retain 96 existing test cases, migrate superseded unsafe expected behaviors to the Issue's new requirements; enrich fixtures with actual complete preview/confirmation bindings. |
| `test/phase2-{intent,identity,hooks,preview,timing}.test.js`, `test/support/harness.js` | New deterministic positive/negative and real-registration tests, 240 asynchronous scheduling cases, privacy and Shadow non-mutation checks. |
| `README.md`, `docs/phase2-p0-001/*` | Current semantics, this audit, test evidence, coverage, limitations, prerequisites and rollback. |

The contract follow-up additionally changes preflight options and introduces `lib/contract.js` / `lib/workflow.js`; its per-file matrix supersedes creation/body details above. `lib/config.js`, `lib/skill.js`, manifest, dependency files, entity extraction implementation and external Skill/MCP are unchanged. Owner list still parses for backward configuration compatibility but grants no authorization.

## Coverage matrix and legacy expectation migration

| Requirement | Evidence | Result |
| --- | --- | --- |
| DEV-01 positive/negative real intent corpus | phase2-intent + TEST-01/02 + H-11 | PASS offline |
| DEV-02 group A/B, cross-session, missing sender, non-user turn | phase2-identity + phase2-hooks; F01–F13 | PASS isolation; sender-less Webchat unsupported |
| DEV-03 requester only, unique Flow denial, stale Factory/revoked invocation | phase2-hooks + phase2-preview missing-sender case + H-03/05 + G11-04/05/06 | PASS offline |
| DEV-04 received/prompt/factory ordering, two users | phase2-timing: 240 schedules, six permutations × 40; Promise, queueMicrotask and setImmediate barriers; 12 concurrent subtests | safety assertions PASS; readiness BLOCKED |
| DEV-05 complete final preview, send success strict, wrong run/user/message/content/token | phase2-preview; TEST-14/14b/20, N06–N08, G11-03/07–10 | PASS offline; live outbound correlation unresolved |
| All nine canonical fields invalidate old confirmation; failed preflight, fill-in, owner override | phase2-preview field loop; G11-08/10; H-12 | PASS offline |
| Trusted boss exception | owner bit alone still PREVIEW_NOT_SENT/CONFIRMATION_REQUIRED; TEST-20 denies confirming another user | BLOCKED: no complete trusted instruction verifier; no bypass implemented |
| Seven required fields and statuses 2/5/6 | original TEST-03–08, H-10; phase2-preview | PASS offline |
| Live-list evidence and narrow entity/request-ID integrity | original E*, DIAG*, N01–N05, H-01/02/07 | PASS regression; extraction unchanged |
| Create-result correlation / in-flight dedup / TTL | original H-04/05/06/08/09, TEST-15/16, F06/07/13, G11-12 | PASS offline |
| Shadow no block, no param mutation, no enforce activation | TEST-19, DIAG-10, registered create tests and config check | PASS offline |
| Privacy | original DIAG-PRIVACY/N-02; phase2-identity/hooks/preview | PASS; no raw IDs, content, code or exception in new logs |

**No old security behavior was silently retained to keep tests green.** The original 96 cases remain named and exercised. Superseded expectations: TEST-14d and G11-03/07 reject incomplete preview text; TEST-20 denies an owner confirming someone else's Flow; G11-04 denies unique-Flow fallback; N06–N08/H-12 reject fill-in-as-confirmation; G11-08–10 require a new final preview after assignee changes. SUP-04/DIAG-09 now require draft evidence rather than allowing hand-set booleans alone. Common fixtures now provide full creation body/priority/assignee and real reply-to/run/call bindings. The contract follow-up removes fictitious create.status and replaces create-receipt completion with solution/status readback; the complete-Skill follow-up requires derived category and both method/result solution content; its migration details are in the current report. These are intentional acceptance changes, not claims that the old assertions ran unchanged. Intermediate red tests reflected these migrations; the final report has zero failures.

Of the 240 scheduling simulations, **120** have no Flow at the initial Factory call, and **120** have no Flow at the initial prompt callback. Later callbacks do not retroactively repair the first tool surface. These are deliberately reproducible gaps, not observed production failure rates. The test suite passing means the simulator consistently detects those gaps and denies unsafe borrowing. It does **not** make DEV-04 PASS or qualify Enforce.

## Runtime prerequisites, unsupported paths and exclusions

1. **No production validation was run.** No production SSH, credentials, GLPI/MCP requests, ticket creation, gateway restart/reload, `doctor --fix`, Core/src/dist/node_modules edits, `openclaw.json` edits, external Skill edits, merge or deployment.
2. **Webchat/Control UI without trusted sender is BLOCKED/unsupported.** A real runtime must demonstrate host sender/session fields; profile display names, `event.from`, prompt text and a unique session Flow are insufficient. Feishu identity propagation is supported by the audited contracts, but actual route behavior still requires separate validation.
3. **First-turn availability is BLOCKED.** The plugin cannot await a future message_received invocation from a synchronous Factory. A new host-supported awaited admission point/rebuild guarantee would need a separate scoped design and proof; do not change Core in this task.
4. **Final delivery correlation is BLOCKED on routes without exact host runId and messageId.** This branch requires the same trusted run through preflight before_tool_call → tool execute call ID → message_sent, plus exact canonical content and success===true. Type declarations and offline adapters do not prove a production route supplies that chain. Split messages, prefixes, markdown/HTML rewriting, truncation or delayed delivery may conservatively fail to record preview. No session-only fallback exists.
5. **Boss exemption is unimplemented/BLOCKED.** `senderIsOwner` and an allowlist alone do not prove a complete authoritative instruction or its exact content. Even the trusted owner bit in tests cannot skip preflight, entities, preview or confirmation. Ordinary technicians require only their own confirmation, never a manager's approval.
6. **Full Skill requirements received through the parent; runtime behavior remains UNKNOWN.** The parent read the archive and supplied vetted text, resolving the prior missing-format evidence block without a local ZIP download. [Current report](skill-contract-reviewed.md) documents method+result solution content, derived category/priority rules, and the explicit priority directive binding. Actual GLPI formatting and transitions remain unverified. Default-assignee mapping/active-user checks are BLOCKED without a reliable get_user contract and evidence; complete customer selection and final completion-reply validation remain limited. No claim of full production compatibility.
7. **Entity limitations unchanged:** sanitized full lists may truncate at about 8014 text characters (Issue evidence, not newly reproduced production evidence). Fallback extraction can recover only early IDs. The gate still requires nonzero list extraction (`entity_lookup_ok`) and a matching `glpi_get_entity` narrow ID. If extraction returns zero, a valid narrow result alone cannot pass. List membership does not prove customer-name correctness; the existing realtime matching/Skill contract remains required. Fix this only in a separate Entity CHG.
8. **REST boundary:** exec+python/direct REST bypasses the specific MCP create matcher. Shadow also never physically blocks any create call. This plugin is neither a universal GLPI authorization barrier nor an Enforce implementation. No credential, REST, executor or MCP policy change is in scope.
9. State is process-local, disappears on restart, and expires after 2h. Inbound substantive edits conservatively revoke draft confirmation. Run/call caps deny excess binding rather than evict live associations. These may increase WOULD_BLOCK observations and require evaluation before deployment.
10. Existing realtime lookup evidence remains attributed to explicit requester and current Flow; ordering/cross-replacement behavior of delayed external tool results was not expanded into an entity-query refactor. No claim is made about all host callback reorderings beyond the tested schedules and bindings.

Deployment prerequisites are review of this draft, resolution/acceptance of each unsupported path in a separately authorized task, runtime proof for the fixed version and actual MCP schemas/delivery formatting, and unchanged `mode=shadow`. Do not deploy this branch based solely on the offline results. **ENFORCE_READY=NO.**

## Rollback

No deployment occurred, so no production rollback is needed now. To undo development work, prepare a review branch that reverts this task's commits in reverse order, preserving unrelated main changes; review `git diff` and run `node --test test/*.test.js`. The base source above is the restoration reference. Do not force-reset shared main, merge automatically or run production commands. If another authorized task later deploys it, that task must retain the previous plugin version, restore it through its approved deployment process, keep Shadow mode, and treat in-memory Flow evidence as lost: users need a fresh Flow and confirmation. This report does not authorize a gateway restart/reload.
