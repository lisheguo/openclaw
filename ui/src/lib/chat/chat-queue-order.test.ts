import { describe, expect, it } from "vitest";
import {
  chatQueueOrderKey,
  compareChatQueueOrder,
  isMovableChatQueueItem,
  reorderChatQueueItems,
} from "./chat-queue-order.ts";
import type { ChatQueueItem } from "./chat-types.ts";

function queued(id: string, createdAt: number, extra: Partial<ChatQueueItem> = {}): ChatQueueItem {
  return { id, text: id, createdAt, ...extra };
}

function orderedIds(queue: readonly ChatQueueItem[]): string[] {
  return queue.toSorted(compareChatQueueOrder).map((item) => item.id);
}

function applyMove(queue: ChatQueueItem[], id: string, toIndex: number): ChatQueueItem[] {
  const changed = new Map(reorderChatQueueItems(queue, id, toIndex).map((item) => [item.id, item]));
  return queue.map((item) => changed.get(item.id) ?? item);
}

describe("chat queue order", () => {
  it("falls back to arrival so an untouched queue stays FIFO", () => {
    const queue = [queued("c", 30), queued("a", 10), queued("b", 20)];

    expect(orderedIds(queue)).toEqual(["a", "b", "c"]);
    expect(chatQueueOrderKey(queue[0]!)).toBe(30);
  });

  it("prefers the operator position over arrival once a row is moved", () => {
    expect(chatQueueOrderKey(queued("a", 30, { orderKey: 10 }))).toBe(10);
  });

  it.each([
    { move: "c", toIndex: 0, expected: ["c", "a", "b"] },
    { move: "a", toIndex: 2, expected: ["b", "c", "a"] },
    { move: "b", toIndex: 0, expected: ["b", "a", "c"] },
  ])("moves $move to index $toIndex", ({ move, toIndex, expected }) => {
    const queue = [queued("a", 10), queued("b", 20), queued("c", 30)];

    expect(orderedIds(applyMove(queue, move, toIndex))).toEqual(expected);
  });

  it("keeps a later arrival behind a reordered queue", () => {
    const moved = applyMove([queued("a", 10), queued("b", 20), queued("c", 30)], "c", 0);

    expect(orderedIds([...moved, queued("d", 40)])).toEqual(["c", "a", "b", "d"]);
  });

  it("separates rows that arrived in the same millisecond so the move sticks", () => {
    const queue = [queued("a", 10), queued("b", 10), queued("c", 10)];

    expect(orderedIds(applyMove(queue, "c", 0))).toEqual(["c", "a", "b"]);
  });

  it("changes nothing when the row is already at that index or absent", () => {
    const queue = [queued("a", 10), queued("b", 20)];

    expect(reorderChatQueueItems(queue, "a", 0)).toEqual([]);
    expect(reorderChatQueueItems(queue, "missing", 0)).toEqual([]);
  });

  it("clamps an out-of-range index to the ends of the queue", () => {
    const queue = [queued("a", 10), queued("b", 20), queued("c", 30)];

    expect(orderedIds(applyMove(queue, "a", 99))).toEqual(["b", "c", "a"]);
    expect(orderedIds(applyMove(queue, "c", -5))).toEqual(["c", "a", "b"]);
  });

  it.each([
    { label: "plain queued row", item: queued("a", 1), movable: true },
    {
      label: "waiting for the run",
      item: queued("a", 1, { sendState: "waiting-idle" }),
      movable: true,
    },
    {
      label: "waiting for reconnect",
      item: queued("a", 1, { sendState: "waiting-reconnect" }),
      movable: true,
    },
    { label: "failed send", item: queued("a", 1, { sendState: "failed" }), movable: true },
    { label: "in-flight send", item: queued("a", 1, { sendState: "sending" }), movable: false },
    { label: "steer chip", item: queued("a", 1, { kind: "steered" }), movable: false },
    { label: "joined a run", item: queued("a", 1, { pendingRunId: "run-1" }), movable: false },
    {
      label: "running a local command",
      item: queued("a", 1, { sendState: "executing-command" }),
      movable: false,
    },
    {
      label: "awaiting settings",
      item: queued("a", 1, { sendState: "waiting-model" }),
      movable: false,
    },
    {
      label: "delivery uncertain",
      item: queued("a", 1, { sendState: "unconfirmed" }),
      movable: false,
    },
  ])("$label is movable: $movable", ({ item, movable }) => {
    expect(isMovableChatQueueItem(item)).toBe(movable);
  });
});
