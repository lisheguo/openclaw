import type { ChatQueueItem } from "./chat-types.ts";

type ChatQueuePosition = Pick<ChatQueueItem, "createdAt" | "orderKey">;

/**
 * Canonical queue position. `orderKey` is the operator-owned position; `createdAt`
 * is the arrival fact and stays the default so an untouched queue is FIFO.
 */
export function chatQueueOrderKey(item: ChatQueuePosition): number {
  return item.orderKey ?? item.createdAt;
}

/**
 * The one queue comparator. Display projection, drain head selection, steer
 * rebuild, and alias merge all sort through it, so what the operator sees is
 * what the Gateway receives. Equal positions keep their existing relative order
 * through sort stability, which is how same-millisecond arrivals stayed FIFO.
 */
export function compareChatQueueOrder(left: ChatQueuePosition, right: ChatQueuePosition): number {
  return chatQueueOrderKey(left) - chatQueueOrderKey(right);
}

/**
 * A row may move while it is still waiting for its turn. Rows already attached
 * to a run — sending, steering, running a command, or awaiting settings — keep
 * their place, so a move can never jump ahead of work already handed over.
 */
export function isMovableChatQueueItem(item: ChatQueueItem): boolean {
  return (
    !item.pendingRunId &&
    item.kind !== "steered" &&
    (item.sendState === undefined ||
      item.sendState === "waiting-idle" ||
      item.sendState === "waiting-reconnect" ||
      item.sendState === "failed")
  );
}

/**
 * Moves one row to `toIndex` and returns only the rows whose position changed.
 * Positions are permuted among the rows instead of minted fresh, so a later
 * arrival — which carries a current `createdAt` — still sorts behind the queue.
 */
export function reorderChatQueueItems(
  queue: readonly ChatQueueItem[],
  id: string,
  toIndex: number,
): ChatQueueItem[] {
  const ordered = queue.toSorted(compareChatQueueOrder);
  const from = ordered.findIndex((item) => item.id === id);
  const to = Math.min(Math.max(toIndex, 0), ordered.length - 1);
  if (from < 0 || from === to) {
    return [];
  }
  const keys = ordered.map(chatQueueOrderKey);
  for (let index = 1; index < keys.length; index += 1) {
    // Same-millisecond arrivals would otherwise share a key and swallow the move.
    keys[index] = Math.max(keys[index]!, keys[index - 1]! + 1);
  }
  const moved = ordered.splice(from, 1)[0]!;
  ordered.splice(to, 0, moved);
  return ordered.flatMap((item, index) =>
    chatQueueOrderKey(item) === keys[index] ? [] : [{ ...item, orderKey: keys[index]! }],
  );
}
