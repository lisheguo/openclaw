// Tests active reply run registry add, lookup, and cleanup behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import {
  getDiagnosticSessionActivitySnapshot,
  resetDiagnosticRunActivityForTest,
} from "../../logging/diagnostic-run-activity.js";
import { MAX_TIMER_TIMEOUT_MS } from "../../shared/number-coercion.js";
import {
  testing,
  abortActiveReplyRuns,
  createReplyOperation,
  forceClearReplyRunBySessionId,
  isReplyRunActiveForSessionId,
  isReplyRunAbortableForCompaction,
  isReplyRunAbortableForSignal,
  queueReplyRunMessage,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS,
  replyRunRegistry,
  retainReplyOperationUntilComplete,
  runAfterReplyOperationClear,
  resolveActiveReplyRunSessionId,
  waitForReplyRunEndBySessionId,
} from "./reply-run-registry.js";

describe("reply run registry", () => {
  afterEach(() => {
    testing.resetReplyRunRegistry();
    resetDiagnosticRunActivityForTest();
    vi.restoreAllMocks();
  });

  it("keeps ownership stable by sessionKey while sessionId rotates", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "session-old",
        resetTriggered: false,
      });

      const oldWaitPromise = waitForReplyRunEndBySessionId("session-old", 1_000);

      operation.updateSessionId("session-new");

      expect(replyRunRegistry.isActive("agent:main:main")).toBe(true);
      expect(resolveActiveReplyRunSessionId("agent:main:main")).toBe("session-new");
      expect(isReplyRunActiveForSessionId("session-old")).toBe(false);
      expect(isReplyRunActiveForSessionId("session-new")).toBe(true);

      let settled = false;
      void oldWaitPromise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);

      operation.complete();

      await expect(oldWaitPromise).resolves.toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("treats queued reply operations as non-abortable for compaction", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-compact",
      resetTriggered: false,
    });

    expect(isReplyRunActiveForSessionId("session-compact")).toBe(true);
    expect(isReplyRunAbortableForCompaction("session-compact")).toBe(false);

    operation.setPhase("running");

    expect(isReplyRunAbortableForCompaction("session-compact")).toBe(true);
  });

  it("mirrors active reply operations into diagnostic work state", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:telegram:direct:chat-1",
      sessionId: "session-1",
      resetTriggered: false,
    });

    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-1",
        sessionKey: "agent:main:telegram:direct:chat-1",
      }).activeWorkKind,
    ).toBe("embedded_run");

    operation.updateSessionId("session-2");

    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-2",
        sessionKey: "agent:main:telegram:direct:chat-1",
      }).activeWorkKind,
    ).toBe("embedded_run");

    operation.complete();

    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-2",
        sessionKey: "agent:main:telegram:direct:chat-1",
      }).activeWorkKind,
    ).toBeUndefined();
  });

  it("clears queued operations immediately on user abort", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-queued",
      resetTriggered: false,
    });

    expect(replyRunRegistry.isActive("agent:main:main")).toBe(true);

    operation.abortByUser();

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
  });

  it("runs completeThen callbacks after active state clears", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-complete",
      resetTriggered: false,
    });
    const afterClear = vi.fn(() => {
      expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
      expect(isReplyRunActiveForSessionId("session-complete")).toBe(false);
    });

    operation.completeThen(afterClear);

    expect(operation.result).toEqual({ kind: "completed" });
    expect(afterClear).toHaveBeenCalledTimes(1);
  });

  it("clears active state before a deferred after-clear barrier settles", async () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-deferred",
      resetTriggered: false,
    });
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const afterClear = vi.fn();
    runAfterReplyOperationClear(operation, afterClear);

    operation.completeWithAfterClearBarrier(barrier);

    expect(operation.result).toEqual({ kind: "completed" });
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
    expect(afterClear).not.toHaveBeenCalled();

    releaseBarrier();
    await barrier;
    await vi.waitFor(() => {
      expect(afterClear).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps later after-clear work behind earlier delivery barriers", async () => {
    const first = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "first-session",
      resetTriggered: false,
    });
    let releaseFirst: () => void = () => {};
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstAfterClear = vi.fn();
    runAfterReplyOperationClear(first, firstAfterClear);
    first.completeWithAfterClearBarrier(firstBarrier);

    const second = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "second-session",
      resetTriggered: false,
    });
    let releaseSecond: () => void = () => {};
    const secondBarrier = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const secondAfterClear = vi.fn();
    runAfterReplyOperationClear(second, secondAfterClear);
    second.completeWithAfterClearBarrier(secondBarrier);

    releaseSecond();
    await secondBarrier;
    expect(secondAfterClear).not.toHaveBeenCalled();

    releaseFirst();
    await firstBarrier;
    await vi.waitFor(() => {
      expect(firstAfterClear).toHaveBeenCalledWith("first-session");
      expect(secondAfterClear).toHaveBeenCalledWith("second-session");
    });
  });

  it("keeps follow-up admission blocked until slow delivery settles", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "hung-session",
        resetTriggered: false,
      });
      let releaseBarrier: () => void = () => {};
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);
      operation.completeWithAfterClearBarrier(barrier, 35 * 60_000);

      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      expect(afterClear).not.toHaveBeenCalled();
      expect(() =>
        createReplyOperation({
          sessionKey: "agent:main:main",
          sessionId: "blocked-session",
          resetTriggered: false,
          respectFollowupAdmissionBarrier: true,
        }),
      ).toThrow("Reply follow-up admission is blocked");

      releaseBarrier();
      await barrier;
      await vi.waitFor(() => {
        expect(afterClear).toHaveBeenCalledWith("hung-session");
      });
      const next = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "next-session",
        resetTriggered: false,
        respectFollowupAdmissionBarrier: true,
      });
      next.complete();
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("extends a hung delivery barrier only while bounded owner work remains active", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "active-owner-session",
        resetTriggered: false,
      });
      let ownerActive = true;
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);
      operation.completeWithAfterClearBarrier(new Promise<void>(() => {}), {
        maxTimeoutMs: REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS * 3,
        shouldExtend: () => ownerActive,
      });

      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      expect(afterClear).not.toHaveBeenCalled();

      ownerActive = false;
      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      await vi.waitFor(() => {
        expect(afterClear).toHaveBeenCalledWith("active-owner-session");
      });
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps follow-up admission blocked during an unsettled inter-block delay", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:mattermost:direct:user-1",
        sessionId: "mattermost-delivery-session",
        resetTriggered: false,
      });
      let settledDeliveryCount = 1;
      const queuedDeliveryCount = 2;
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);
      operation.completeWithAfterClearBarrier(new Promise<void>(() => {}), {
        maxTimeoutMs: REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS * 3,
        shouldExtend: () => settledDeliveryCount < queuedDeliveryCount,
      });

      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      expect(afterClear).not.toHaveBeenCalled();
      expect(() =>
        createReplyOperation({
          sessionKey: "agent:main:mattermost:direct:user-1",
          sessionId: "queued-followup",
          resetTriggered: false,
          respectFollowupAdmissionBarrier: true,
        }),
      ).toThrow();

      settledDeliveryCount = 2;
      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      await vi.waitFor(() => {
        expect(afterClear).toHaveBeenCalledWith("mattermost-delivery-session");
      });

      const followup = createReplyOperation({
        sessionKey: "agent:main:mattermost:direct:user-1",
        sessionId: "admitted-followup",
        resetTriggered: false,
        respectFollowupAdmissionBarrier: true,
      });
      followup.complete();
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("eventually releases a permanently hung delivery barrier at the default timeout", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "hung-session",
        resetTriggered: false,
      });
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);
      operation.completeWithAfterClearBarrier(new Promise<void>(() => {}));

      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS - 1);
      expect(afterClear).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => {
        expect(afterClear).toHaveBeenCalledWith("hung-session");
      });
      const next = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "next-session",
        resetTriggered: false,
        respectFollowupAdmissionBarrier: true,
      });
      next.complete();
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("retains failed operations until final delivery completes", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-failed",
      resetTriggered: false,
    });
    const afterClear = vi.fn();
    operation.retainFailureUntilComplete();
    runAfterReplyOperationClear(operation, afterClear);

    operation.fail("run_failed", new Error("provider failed"));

    expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    expect(replyRunRegistry.get("agent:main:main")).toBe(operation);
    expect(afterClear).not.toHaveBeenCalled();

    operation.complete();

    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
    expect(afterClear).toHaveBeenCalledTimes(1);
  });

  it("keeps retained terminal failures immutable across late aborts", () => {
    const upstreamAbort = new AbortController();
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:failed-final",
      sessionId: "session-failed-final",
      resetTriggered: false,
      upstreamAbortSignal: upstreamAbort.signal,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
      isAbortable: () => true,
    });
    operation.setPhase("running");
    operation.retainFailureUntilComplete();

    operation.fail("run_failed", new Error("provider failed"));
    upstreamAbort.abort(new Error("late upstream abort"));

    expect(operation.abortSignal.aborted).toBe(false);
    expect(operation.abortByUser()).toBe(false);
    expect(operation.abortForRestart()).toBe(false);
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    expect(operation.phase).toBe("failed");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("records upstream cancellation as an aborted operation", () => {
    const upstreamAbort = new AbortController();
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:upstream-cancelled",
      sessionId: "session-upstream-cancelled",
      resetTriggered: false,
      upstreamAbortSignal: upstreamAbort.signal,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });
    operation.setPhase("running");

    upstreamAbort.abort(new Error("caller cancelled"));

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(operation.phase).toBe("aborted");
    expect(operation.abortSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith("user_abort");
    operation.complete();
  });

  it("records upstream restart cancellation separately", () => {
    const upstreamAbort = new AbortController();
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:upstream-restart",
      sessionId: "session-upstream-restart",
      resetTriggered: false,
      upstreamAbortSignal: upstreamAbort.signal,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });
    operation.setPhase("running");

    upstreamAbort.abort(createAgentRunRestartAbortError());

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(operation.phase).toBe("aborted");
    expect(operation.abortSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith("restart");
    operation.complete();
  });

  it("clears queued ownership when the upstream signal is already aborted", () => {
    const upstreamAbort = new AbortController();
    upstreamAbort.abort(new Error("caller already cancelled"));

    const operation = createReplyOperation({
      sessionKey: "agent:main:already-cancelled",
      sessionId: "session-already-cancelled",
      resetTriggered: false,
      upstreamAbortSignal: upstreamAbort.signal,
    });

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(operation.phase).toBe("aborted");
    expect(operation.abortSignal.aborted).toBe(true);
    expect(replyRunRegistry.isActive("agent:main:already-cancelled")).toBe(false);
  });

  it("does not cancel the backend twice when upstream abort follows a user abort", () => {
    const upstreamAbort = new AbortController();
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:duplicate-cancel",
      sessionId: "session-duplicate-cancel",
      resetTriggered: false,
      upstreamAbortSignal: upstreamAbort.signal,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });
    operation.setPhase("running");

    expect(operation.abortByUser()).toBe(true);
    upstreamAbort.abort(createAgentRunRestartAbortError());

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("user_abort");
    operation.complete();
  });

  it("force-clears retained failed operations", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-retained",
      resetTriggered: false,
    });
    operation.retainFailureUntilComplete();

    expect(forceClearReplyRunBySessionId("session-retained", new Error("stuck"))).toBe(true);
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
  });

  it("force-clears a running operation after abort without backend cleanup", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "session-running",
        resetTriggered: false,
      });
      operation.attachBackend({
        kind: "embedded",
        cancel,
        isStreaming: () => true,
      });
      operation.setPhase("running");

      operation.abortByUser();
      const waitPromise = waitForReplyRunEndBySessionId("session-running", 1_000);

      expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
      expect(cancel).toHaveBeenCalledWith("user_abort");
      expect(isReplyRunActiveForSessionId("session-running")).toBe(true);

      expect(forceClearReplyRunBySessionId("session-running", new Error("stuck"))).toBe(true);

      expect(isReplyRunActiveForSessionId("session-running")).toBe(false);
      await expect(waitPromise).resolves.toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("rejects aborts while the attached backend is finalizing", () => {
    let abortable = false;
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:finalizing",
      sessionId: "session-finalizing",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
      isAbortable: () => abortable,
    });
    operation.setPhase("running");

    expect(replyRunRegistry.abort("agent:main:finalizing")).toBe(false);
    expect(abortActiveReplyRuns({ mode: "all" })).toBe(false);
    expect(operation.result).toBeNull();
    expect(cancel).not.toHaveBeenCalled();

    abortable = true;
    expect(replyRunRegistry.abort("agent:main:finalizing")).toBe(true);
    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(cancel).toHaveBeenCalledWith("user_abort");
  });

  it("keeps finalizing reply bookkeeping through forced in-process restart", () => {
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:restart-finalizing",
      sessionId: "session-restart-finalizing",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
      isAbortable: () => false,
    });
    operation.setPhase("running");

    expect(abortActiveReplyRuns({ mode: "all" })).toBe(false);
    expect(replyRunRegistry.isActive("agent:main:restart-finalizing")).toBe(true);
    expect(operation.result).toBeNull();
    expect(cancel).not.toHaveBeenCalled();

    operation.complete();
    expect(replyRunRegistry.isActive("agent:main:restart-finalizing")).toBe(false);
  });

  it("keeps abort frozen after the backend detaches for reply delivery", () => {
    const cancel = vi.fn();
    const upstreamAbort = new AbortController();
    const operation = createReplyOperation({
      sessionKey: "agent:main:delivery-finalizing",
      sessionId: "session-delivery-finalizing",
      resetTriggered: false,
      upstreamAbortSignal: upstreamAbort.signal,
    });
    const backend = {
      kind: "embedded" as const,
      cancel,
      isStreaming: () => false,
      isAbortable: () => false,
    };
    operation.attachBackend(backend);
    operation.setPhase("running");
    operation.freezeAbort();
    operation.detachBackend(backend);

    expect(isReplyRunAbortableForSignal(upstreamAbort.signal)).toBe(false);
    expect(isReplyRunAbortableForSignal(new AbortController().signal)).toBe(true);
    expect(replyRunRegistry.abort("agent:main:delivery-finalizing")).toBe(false);
    expect(operation.result).toBeNull();
    expect(cancel).not.toHaveBeenCalled();

    upstreamAbort.abort();
    expect(operation.abortSignal.aborted).toBe(false);

    operation.complete();
    expect(replyRunRegistry.isActive("agent:main:delivery-finalizing")).toBe(false);
    expect(isReplyRunAbortableForSignal(upstreamAbort.signal)).toBe(false);
  });

  it("clamps oversized wait timers instead of resolving idle waits immediately", async () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "session-running",
        resetTriggered: false,
      });

      const waitPromise = waitForReplyRunEndBySessionId(
        "session-running",
        MAX_TIMER_TIMEOUT_MS + 1,
      );

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      operation.complete();
      await expect(waitPromise).resolves.toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("queues messages only through the active running backend", () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-running",
      resetTriggered: false,
    });

    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      queueMessage,
    });

    expect(queueReplyRunMessage("session-running", "before running")).toBe(false);

    operation.setPhase("running");

    expect(queueReplyRunMessage("session-running", "hello")).toBe(true);
    expect(queueMessage).toHaveBeenCalledWith("hello");
  });

  it("queues messages through active non-streaming backends with live stopped state", () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-running",
      resetTriggered: false,
    });

    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => false,
      isStopped: () => false,
      queueMessage,
    });
    operation.setPhase("running");

    expect(queueReplyRunMessage("session-running", "hello")).toBe(true);
    expect(queueMessage).toHaveBeenCalledWith("hello");
  });

  it("does not queue messages through stopped backends", () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-running",
      resetTriggered: false,
    });

    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      isStopped: () => true,
      queueMessage,
    });
    operation.setPhase("running");

    expect(queueReplyRunMessage("session-running", "hello")).toBe(false);
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("fails closed when backend stopped state checks throw", () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-running",
      resetTriggered: false,
    });

    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      isStopped: () => {
        throw new Error("bad stopped state");
      },
      queueMessage,
    });
    operation.setPhase("running");

    expect(queueReplyRunMessage("session-running", "hello")).toBe(false);
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("aborts compacting runs through the registry compatibility helper", () => {
    const compactingOperation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-compacting",
      resetTriggered: false,
    });
    compactingOperation.setPhase("preflight_compacting");

    const runningOperation = createReplyOperation({
      sessionKey: "agent:main:other",
      sessionId: "session-running",
      resetTriggered: false,
    });
    runningOperation.setPhase("running");

    expect(abortActiveReplyRuns({ mode: "compacting" })).toBe(true);
    expect(compactingOperation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(runningOperation.result).toBeNull();
  });

  // ── Gate 2A: Terminal bounded settlement ──

  it("CASE 1: running abortByUser with hanging owner settles after timeout", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:case1",
        sessionId: "session-case1",
        resetTriggered: false,
      });
      operation.setPhase("running");

      operation.abortByUser();

      expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
      // Registry stays active while waiting for owner to complete()
      expect(replyRunRegistry.isActive("agent:main:case1")).toBe(true);

      // Before timeout: still active
      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS - 1);
      expect(replyRunRegistry.isActive("agent:main:case1")).toBe(true);

      // At timeout: force-settled
      await vi.advanceTimersByTimeAsync(1);
      expect(replyRunRegistry.isActive("agent:main:case1")).toBe(false);

      const waitResult = await replyRunRegistry.waitForIdle("agent:main:case1", 100);
      expect(waitResult).toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("CASE 2: running abortForRestart with hanging owner settles after timeout", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:case2",
        sessionId: "session-case2",
        resetTriggered: false,
      });
      operation.setPhase("running");

      operation.abortForRestart();

      expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
      expect(replyRunRegistry.isActive("agent:main:case2")).toBe(true);

      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS - 1);
      expect(replyRunRegistry.isActive("agent:main:case2")).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      expect(replyRunRegistry.isActive("agent:main:case2")).toBe(false);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("CASE 3: upstream abort with hanging owner settles after timeout", async () => {
    vi.useFakeTimers();
    try {
      const upstreamAbort = new AbortController();
      const operation = createReplyOperation({
        sessionKey: "agent:main:case3",
        sessionId: "session-case3",
        resetTriggered: false,
        upstreamAbortSignal: upstreamAbort.signal,
      });
      operation.setPhase("running");

      upstreamAbort.abort(new Error("caller cancelled"));

      expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
      expect(replyRunRegistry.isActive("agent:main:case3")).toBe(true);

      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS - 1);
      expect(replyRunRegistry.isActive("agent:main:case3")).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      expect(replyRunRegistry.isActive("agent:main:case3")).toBe(false);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("CASE 4: owner timely complete cancels terminal settle timer", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:case4",
        sessionId: "session-case4",
        resetTriggered: false,
      });
      operation.setPhase("running");

      operation.abortByUser();
      expect(replyRunRegistry.isActive("agent:main:case4")).toBe(true);

      // Owner completes before timer fires
      await vi.advanceTimersByTimeAsync(20_000);
      operation.complete();

      expect(replyRunRegistry.isActive("agent:main:case4")).toBe(false);

      // Advance past timeout — must NOT cause errors or second clear
      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);
      expect(replyRunRegistry.isActive("agent:main:case4")).toBe(false);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("CASE 5: late complete after forced release is harmless", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:case5",
        sessionId: "session-case5",
        resetTriggered: false,
      });
      operation.setPhase("running");

      operation.abortByUser();

      // Timer force-clears
      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);
      expect(replyRunRegistry.isActive("agent:main:case5")).toBe(false);

      // Late owner complete — must not throw or re-register
      operation.complete();
      expect(replyRunRegistry.isActive("agent:main:case5")).toBe(false);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("CASE 6: queued abort clears immediately without waiting for settle", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:case6",
      sessionId: "session-case6",
      resetTriggered: false,
    });
    // Phase is still "queued"
    operation.abortByUser();

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive("agent:main:case6")).toBe(false);
  });

  it("CASE 7: retained failure with hanging owner settles after timeout", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:case7",
        sessionId: "session-case7",
        resetTriggered: false,
      });
      operation.retainFailureUntilComplete();
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);

      operation.fail("run_failed", new Error("provider failed"));

      expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
      expect(replyRunRegistry.isActive("agent:main:case7")).toBe(true);
      expect(afterClear).not.toHaveBeenCalled();

      // Before timeout: still active
      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS - 1);
      expect(replyRunRegistry.isActive("agent:main:case7")).toBe(true);

      // At timeout: force-settled
      await vi.advanceTimersByTimeAsync(1);
      expect(replyRunRegistry.isActive("agent:main:case7")).toBe(false);

      // after-clear callback fires exactly once
      await vi.waitFor(() => {
        expect(afterClear).toHaveBeenCalledTimes(1);
      });

      const waitResult = await replyRunRegistry.waitForIdle("agent:main:case7", 100);
      expect(waitResult).toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("CASE 8: retainReplyOperationUntilComplete + fail + hanging owner settles", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:case8",
        sessionId: "session-case8",
        resetTriggered: false,
      });
      retainReplyOperationUntilComplete(operation);
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);

      operation.fail("run_failed", new Error("provider failed"));

      expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
      expect(replyRunRegistry.isActive("agent:main:case8")).toBe(true);

      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS - 1);
      expect(replyRunRegistry.isActive("agent:main:case8")).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      expect(replyRunRegistry.isActive("agent:main:case8")).toBe(false);
      await vi.waitFor(() => {
        expect(afterClear).toHaveBeenCalledTimes(1);
      });
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("CASE 9: old operation timer does not clear a newer operation", async () => {
    vi.useFakeTimers();
    try {
      const first = createReplyOperation({
        sessionKey: "agent:main:case9",
        sessionId: "session-first",
        resetTriggered: false,
      });
      first.setPhase("running");
      first.abortByUser();
      // Timer is now armed for `first`

      // Owner of `first` completes, clearing state and cancelling its timer
      first.complete();
      expect(replyRunRegistry.isActive("agent:main:case9")).toBe(false);

      // A new operation takes the same sessionKey
      const second = createReplyOperation({
        sessionKey: "agent:main:case9",
        sessionId: "session-second",
        resetTriggered: false,
      });
      second.setPhase("running");
      expect(replyRunRegistry.isActive("agent:main:case9")).toBe(true);

      // Advance past the original 60s — `second` must survive
      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS + 5_000);
      expect(replyRunRegistry.isActive("agent:main:case9")).toBe(true);

      second.complete();
      expect(replyRunRegistry.isActive("agent:main:case9")).toBe(false);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("CASE 10: repeated retained fail does not extend settle window", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:case10",
        sessionId: "session-case10",
        resetTriggered: false,
      });
      operation.retainFailureUntilComplete();

      // T=0: first fail starts the settle timer
      operation.fail("run_failed", new Error("first failure"));
      expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
      expect(replyRunRegistry.isActive("agent:main:case10")).toBe(true);

      // Advance 50s — still within the original 60s window
      await vi.advanceTimersByTimeAsync(50_000);
      expect(replyRunRegistry.isActive("agent:main:case10")).toBe(true);

      // Second fail call — must NOT reset the timer
      operation.fail("run_failed", new Error("second failure"));
      expect(replyRunRegistry.isActive("agent:main:case10")).toBe(true);

      // Advance 10s — total 60s from first fail → settle fires
      await vi.advanceTimersByTimeAsync(10_000);
      expect(replyRunRegistry.isActive("agent:main:case10")).toBe(false);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("CASE 11: scheduling after state cleared does not create effective timer", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:case11",
      sessionId: "session-case11",
      resetTriggered: false,
    });
    operation.setPhase("running");

    // Normal complete clears state
    operation.complete();
    expect(replyRunRegistry.isActive("agent:main:case11")).toBe(false);

    // A late fail after state is cleared must not re-register the operation
    operation.fail("run_failed", new Error("late failure"));
    expect(replyRunRegistry.isActive("agent:main:case11")).toBe(false);
  });
});
