// Control UI E2E proof that a replaced session ends in a stated terminal outcome.
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  activateMenuItem,
  captureUiProof,
  createSessionManagementE2eSuite,
  installMockGateway,
  openSessionMenuSubmenu,
  requireRecord,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

async function nameTheGroup(page: Page, value: string): Promise<void> {
  const field = page.locator("openclaw-modal-dialog input");
  await field.waitFor({ state: "visible" });
  await field.fill(value);
  await field.press("Enter");
}

suite.define(() => {
  it("closes out a replaced session with a terminal outcome on both surfaces", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.patch"],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.groups.list",
        "sessions.groups.put",
        "sessions.patch",
      ],
      methodResponses: {
        "sessions.list": sessionsListResponse([
          {
            ...sessionRow("agent:main:move-me", "Move me", Date.parse("2026-07-01T16:00:00.000Z")),
            sessionId: "sess-before-reset",
          },
        ]),
      },
      sessionKey: "agent:main:move-me",
    });

    async function refuseReplacedTarget() {
      const patch = await gateway.waitForRequest("sessions.patch");
      // The row proved which session it meant; the store now holds another one.
      expect(requireRecord(patch.params)).toMatchObject({
        expectedSessionId: "sess-before-reset",
        key: "agent:main:move-me",
      });
      await gateway.rejectDeferred("sessions.patch", {
        code: "INVALID_REQUEST",
        details: { code: "SESSION_CHANGED" },
        message: "Session agent:main:move-me changed before patch. Retry.",
      });
    }

    try {
      // Sidebar: the group lands, the move cannot, and the dialog says so without
      // offering the attempt again.
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator('.sidebar-recent-session[data-session-key="agent:main:move-me"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await row.hover();
      await row.getByRole("button", { name: "Open session menu" }).click();
      await openSessionMenuSubmenu(page, "Move to group");
      await activateMenuItem(page.getByRole("menuitem", { name: "New group…" }));
      // Not submitInputDialog: a terminal outcome keeps the dialog on screen, so
      // waiting for the field to detach would wait for something that must not happen.
      await nameTheGroup(page, "Client work");
      await refuseReplacedTarget();

      const dialogAlert = page.locator('openclaw-modal-dialog [role="alert"]');
      await dialogAlert.waitFor({ state: "visible" });
      await expect
        .poll(() => dialogAlert.textContent())
        .toContain("Group created. This session was replaced and did not move. Select it again.");
      expect(await page.getByRole("button", { name: "Create group" }).count()).toBe(0);
      await captureUiProof(page, "session-replaced-dialog-dark.png");
      await page.emulateMedia({ colorScheme: "light" });
      await captureUiProof(page, "session-replaced-dialog-light.png");
      await page.emulateMedia({ colorScheme: "dark" });
      await page.getByRole("button", { name: "Close" }).click();
      await expect.poll(() => dialogAlert.count()).toBe(0);

      // The sidebar keeps the same statement after the dialog is gone.
      const sidebarError = page.locator("[data-sidebar-session-error]");
      await expect
        .poll(() => sidebarError.textContent())
        .toContain("Group created. This session was replaced and did not move. Select it again.");
      await captureUiProof(page, "session-replaced-sidebar-dark.png");

      // Sessions page: same flow, same semantics, same copy — one design, two mounts.
      await page.goto(`${suite.server.baseUrl}sessions`);
      const pageRow = page.locator("tr", { hasText: "Move me" }).first();
      await pageRow.waitFor({ state: "visible", timeout: 10_000 });
      await pageRow.getByRole("button", { name: "Open session menu" }).click();
      await openSessionMenuSubmenu(page, "Move to group");
      await activateMenuItem(page.getByRole("menuitem", { name: "New group…" }));
      await nameTheGroup(page, "Client work");
      await refuseReplacedTarget();

      await expect
        .poll(() => page.locator('openclaw-modal-dialog [role="alert"]').textContent())
        .toContain("Group created. This session was replaced and did not move. Select it again.");
      await captureUiProof(page, "session-replaced-sessions-page-dark.png");
      await page.emulateMedia({ colorScheme: "light" });
      await captureUiProof(page, "session-replaced-sessions-page-light.png");
      await page.getByRole("button", { name: "Close" }).click();
      // The page banner keeps the outcome after the dialog is dismissed.
      await expect
        .poll(() => page.locator(".sessions-error").textContent())
        .toContain("Group created. This session was replaced and did not move. Select it again.");
    } finally {
      await context.close();
    }
  });
});
