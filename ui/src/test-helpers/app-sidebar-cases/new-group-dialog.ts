import { ErrorCodes, GatewayErrorDetailCodes } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import {
  installDialogPolyfill,
  submitInputDialog,
  waitForInputDialog,
  waitForRenderedModalDialog,
} from "../modal-dialog.ts";
import { waitForFast } from "../wait-for.ts";
import {
  click,
  mountMultiSelect,
  openContextMenu,
  rowLink,
  sessionMenu,
} from "./multi-select-support.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar new group dialog", () => {
  it("writes a new group catalog before assigning the selection through patchMany", async () => {
    const restoreDialogPolyfill = installDialogPolyfill();
    try {
      const { sidebar, harness } = await mountMultiSelect([
        "sessions.groups.put",
        "sessions.patchMany",
      ]);
      click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
      click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
      await sidebar.updateComplete;
      openContextMenu(sidebar, "agent:main:a");
      await sidebar.updateComplete;
      const menu = await sessionMenu(sidebar);
      menu.querySelector<HTMLElement>('wa-dropdown-item[value="new-group"]')?.click();

      // Opening the owned dialog is inert: nothing reaches the Gateway until a
      // name is submitted, and the submitted name is trimmed.
      await waitForInputDialog();
      expect(harness.groupsPut).not.toHaveBeenCalled();
      expect(harness.patchMany).not.toHaveBeenCalled();
      await submitInputDialog("  Projects  ");

      await waitForFast(() => expect(harness.patchMany).toHaveBeenCalledOnce());
      expect(harness.groupsPut).toHaveBeenCalledWith(["Projects"]);
      // Each target carries the identity captured with its row, so a session
      // replaced while the dialog was open is refused instead of reassigned.
      expect(harness.patchMany).toHaveBeenCalledWith(
        [
          { key: "agent:main:a", agentId: "main", expectedSessionId: "session-agent:main:a" },
          { key: "agent:main:b", agentId: "main", expectedSessionId: "session-agent:main:b" },
        ],
        { category: "Projects" },
      );
      expect(harness.groupsPut.mock.invocationCallOrder[0]).toBeLessThan(
        harness.patchMany.mock.invocationCallOrder[0]!,
      );
      expect(harness.patch).not.toHaveBeenCalled();
      await waitForFast(() => expect(harness.refreshReplacement).toHaveBeenCalledOnce());
    } finally {
      restoreDialogPolyfill();
    }
  });

  it("assigns with captured identities when rows leave the list mid-write", async () => {
    const restoreDialogPolyfill = installDialogPolyfill();
    try {
      const { sidebar, harness } = await mountMultiSelect([
        "sessions.groups.put",
        "sessions.patchMany",
      ]);
      let landCatalogWrite!: () => void;
      harness.groupsPut.mockReturnValueOnce(
        new Promise((resolve) => {
          landCatalogWrite = () => resolve("completed");
        }),
      );
      click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
      click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
      await sidebar.updateComplete;
      openContextMenu(sidebar, "agent:main:a");
      await sidebar.updateComplete;
      const menu = await sessionMenu(sidebar);
      menu.querySelector<HTMLElement>('wa-dropdown-item[value="new-group"]')?.click();

      await waitForInputDialog();
      await submitInputDialog("Projects");
      await waitForFast(() => expect(harness.groupsPut).toHaveBeenCalledOnce());

      // Both rows leave this bounded, filtered projection while the catalog write
      // is in flight. That is not evidence they were deleted, so the assignment
      // still goes out, carrying the identity captured with each row — which is
      // what lets the Gateway refuse a target that really was replaced.
      harness.publish({ result: { count: 0, sessions: [] } as unknown as SessionsListResult });
      landCatalogWrite();

      await waitForFast(() => expect(harness.patchMany).toHaveBeenCalledOnce());
      expect(harness.patchMany).toHaveBeenCalledWith(
        [
          { key: "agent:main:a", agentId: "main", expectedSessionId: "session-agent:main:a" },
          { key: "agent:main:b", agentId: "main", expectedSessionId: "session-agent:main:b" },
        ],
        { category: "Projects" },
      );
      expect(harness.patch).not.toHaveBeenCalled();
    } finally {
      restoreDialogPolyfill();
    }
  });

  it("states a replaced target in the dialog and stops offering the attempt", async () => {
    const restoreDialogPolyfill = installDialogPolyfill();
    try {
      const { sidebar, harness } = await mountMultiSelect([
        "sessions.groups.put",
        "sessions.patchMany",
      ]);
      harness.patchMany.mockResolvedValueOnce({
        outcomes: [
          {
            ok: false,
            key: "agent:main:a",
            agentId: "main",
            error: {
              code: ErrorCodes.INVALID_REQUEST,
              message: "Session agent:main:a changed before patch. Retry.",
              details: { code: GatewayErrorDetailCodes.SESSION_CHANGED },
            },
          },
          { ok: true, key: "agent:main:b", agentId: "main" },
        ],
      });
      click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
      click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
      await sidebar.updateComplete;
      openContextMenu(sidebar, "agent:main:a");
      await sidebar.updateComplete;
      const menu = await sessionMenu(sidebar);
      menu.querySelector<HTMLElement>('wa-dropdown-item[value="new-group"]')?.click();

      await waitForInputDialog();
      await submitInputDialog("Projects");
      await waitForFast(() => expect(harness.patchMany).toHaveBeenCalledOnce());

      // The group landed and the replaced row never can: the dialog stays to say
      // both and drops its submit, because resending cannot change the outcome.
      const { modal } = await waitForRenderedModalDialog(document.body);
      await waitForFast(() =>
        expect(modal.querySelector(".exec-approval-error")?.textContent?.trim()).toBe(
          "Group created. Sessions that were replaced did not move. Select them again.",
        ),
      );
      expect(modal.querySelector('button[type="submit"]')).toBeNull();
      const close = modal.querySelector<HTMLButtonElement>(".input-dialog__close");
      expect(close?.textContent?.trim()).toBe("Close");
      close?.click();
      await waitForFast(() =>
        expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull(),
      );
      expect(harness.patchMany).toHaveBeenCalledOnce();
    } finally {
      restoreDialogPolyfill();
    }
  });

  it("reports the partial outcome when only part of the selection leaves the list", async () => {
    const restoreDialogPolyfill = installDialogPolyfill();
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    await toastHost.updateComplete;
    try {
      const { sidebar, harness } = await mountMultiSelect([
        "sessions.groups.put",
        "sessions.patch",
        "sessions.patchMany",
      ]);
      let landCatalogWrite!: () => void;
      harness.groupsPut.mockReturnValueOnce(
        new Promise((resolve) => {
          landCatalogWrite = () => resolve("completed");
        }),
      );
      click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
      click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
      await sidebar.updateComplete;
      openContextMenu(sidebar, "agent:main:a");
      await sidebar.updateComplete;
      const menu = await sessionMenu(sidebar);
      menu.querySelector<HTMLElement>('wa-dropdown-item[value="new-group"]')?.click();

      await waitForInputDialog();
      await submitInputDialog("Projects");
      await waitForFast(() => expect(harness.groupsPut).toHaveBeenCalledOnce());

      // Only one of the two selected rows survives the catalog write. Moving the
      // survivor is still correct, but the other row was requested and skipped.
      harness.publish({
        result: {
          count: 1,
          sessions: [{ key: "agent:main:b", agentId: "main" }],
        } as unknown as SessionsListResult,
      });
      landCatalogWrite();

      await waitForFast(() =>
        expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull(),
      );
      // The surviving row is patched on its own; the removed key is never sent,
      // so patchMany stays out of it.
      await waitForFast(() => expect(harness.patch).toHaveBeenCalledOnce());
      expect(harness.patch).toHaveBeenCalledWith(
        "agent:main:b",
        { category: "Projects" },
        { agentId: "main" },
      );
      expect(harness.patchMany).not.toHaveBeenCalled();
      // A partly applied selection must not close as a plain success.
      expect(toastHost.querySelector(".app-toast__message")?.textContent).toBe(
        "Group created, but some selected sessions were not moved because the list changed. Move them from the row menu.",
      );
    } finally {
      toastHost.remove();
      restoreDialogPolyfill();
    }
  });
});
