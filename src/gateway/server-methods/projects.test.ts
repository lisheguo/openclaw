import { describe, expect, it, vi } from "vitest";
import { PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createProjectsHandlers } from "./projects.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const seededSessions = vi.hoisted(() => ({
  store: {} as Record<string, SessionEntry>,
}));

vi.mock("../session-utils.js", () => ({
  loadCombinedSessionStoreForGateway: () => ({ store: seededSessions.store }),
}));

function authenticatedClient(user: string, scopes = ["operator.read"]): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes,
    },
    authenticatedUserId: user,
    authenticatedUserProfile: {
      profileId: user,
      displayName: user,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

describe("projects.list", () => {
  it("groups gateway session checkouts by repository fingerprint", async () => {
    seededSessions.store = {
      "agent:main:alpha-old": {
        sessionId: "alpha-old",
        updatedAt: 100,
        execCwd: "/repos/alpha-main",
      },
      "agent:main:alpha-new": {
        sessionId: "alpha-new",
        updatedAt: 300,
        execCwd: "/repos/alpha-worktree",
      },
      "agent:main:device": {
        sessionId: "device",
        updatedAt: 400,
        execCwd: "/device/alpha",
        execNode: "paired-mac",
      },
    };
    const config: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true }] },
    };
    const resolveRepositoryIdentity = vi.fn(async (checkoutPath: string) => ({
      checkoutRoot: checkoutPath,
      repoRoot: checkoutPath,
      originUrl: "https://github.com/openclaw/alpha.git",
      fingerprint: "alpha-fingerprint",
    }));
    const handlers = createProjectsHandlers({
      list: vi.fn(async () => []),
      resolveRepositoryIdentity,
    } as never);
    const responses: Parameters<RespondFn>[] = [];
    await handlers["projects.list"]?.({
      params: {},
      respond: (...response: Parameters<RespondFn>) => responses.push(response),
      context: { getRuntimeConfig: () => config } as GatewayRequestContext,
    } as never);

    expect(responses).toEqual([
      [
        true,
        {
          projects: [
            {
              name: "alpha-worktree",
              originUrl: "https://github.com/openclaw/alpha.git",
              checkouts: [
                { runnerId: "gateway", path: "/repos/alpha-worktree" },
                { runnerId: "gateway", path: "/repos/alpha-main" },
              ],
              lastUsedAt: 300,
            },
          ],
        },
        undefined,
      ],
    ]);
    expect(resolveRepositoryIdentity).toHaveBeenCalledTimes(2);
    expect(resolveRepositoryIdentity).not.toHaveBeenCalledWith("/device/alpha");
  });

  it("keeps distinct managed worktree checkout paths under one project", async () => {
    seededSessions.store = {
      "agent:main:alpha-session": {
        sessionId: "alpha-session",
        updatedAt: 250,
        execCwd: "/repos/alpha-session",
      },
    };
    const config: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true }] },
    };
    const resolveRepositoryIdentity = vi.fn(async (checkoutPath: string) => ({
      checkoutRoot: checkoutPath,
      repoRoot: "/repos/alpha-main",
      originUrl: "https://github.com/openclaw/alpha.git",
      fingerprint: "alpha-fingerprint",
    }));
    const handlers = createProjectsHandlers({
      list: vi.fn(async () => [
        {
          id: "worktree-a",
          name: "feature-a",
          repoFingerprint: "alpha-fingerprint",
          repoRoot: "/repos/alpha-main",
          path: "/state/worktrees/alpha/feature-a",
          branch: "openclaw/feature-a",
          baseRef: "main",
          ownerKind: "session",
          createdAt: 100,
          lastActiveAt: 300,
        },
        {
          id: "worktree-b",
          name: "feature-b",
          repoFingerprint: "alpha-fingerprint",
          repoRoot: "/repos/alpha-main",
          path: "/state/worktrees/alpha/feature-b",
          branch: "openclaw/feature-b",
          baseRef: "main",
          ownerKind: "session",
          createdAt: 100,
          lastActiveAt: 200,
        },
      ]),
      resolveRepositoryIdentity,
    } as never);
    const respond = vi.fn();

    await handlers["projects.list"]?.({
      params: {},
      respond,
      context: { getRuntimeConfig: () => config } as GatewayRequestContext,
    } as never);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        projects: [
          {
            name: "feature-a",
            originUrl: "https://github.com/openclaw/alpha.git",
            checkouts: [
              { runnerId: "gateway", path: "/state/worktrees/alpha/feature-a" },
              { runnerId: "gateway", path: "/repos/alpha-session" },
              { runnerId: "gateway", path: "/state/worktrees/alpha/feature-b" },
            ],
            lastUsedAt: 300,
          },
        ],
      },
      undefined,
    );
    expect(resolveRepositoryIdentity.mock.calls).toEqual([
      ["/repos/alpha-main"],
      ["/repos/alpha-session"],
    ]);
  });

  it("limits session-owned worktrees to sessions visible to the requesting client", async () => {
    seededSessions.store = {
      "agent:main:owned-draft": {
        sessionId: "owned-draft",
        updatedAt: 400,
        execCwd: "/private/draft-secret-name",
        visibility: "draft",
        createdActor: { type: "human", id: "owner@example.com" },
      },
      "agent:main:dashboard:incognito-private": {
        sessionId: "incognito-private",
        updatedAt: 300,
        execCwd: "/private/incognito-secret-name",
        visibility: "shared",
        incognito: true,
        createdActor: { type: "human", id: "owner@example.com" },
      },
      "agent:main:visible": {
        sessionId: "visible",
        updatedAt: 200,
        execCwd: "/repos/ordinary-visible",
        visibility: "shared",
        createdActor: { type: "human", id: "owner@example.com" },
      },
    };
    const resolveRepositoryIdentity = vi.fn(async (checkoutPath: string) => ({
      checkoutRoot: checkoutPath,
      repoRoot: checkoutPath,
      originUrl: `https://example.test${checkoutPath}.git`,
      fingerprint: checkoutPath,
    }));
    const worktrees = [
      {
        id: "visible-session-worktree",
        name: "visible-session-worktree",
        repoFingerprint: "visible-session-worktree-fingerprint",
        repoRoot: "/repos/visible-session-root",
        path: "/state/worktrees/visible-session-owned",
        branch: "openclaw/visible-session-owned",
        baseRef: "main",
        ownerKind: "session",
        ownerId: "agent:main:visible",
        createdAt: 100,
        lastActiveAt: 500,
      },
      {
        id: "draft-session-worktree",
        name: "draft-secret-worktree-name",
        repoFingerprint: "draft-secret-worktree-fingerprint",
        repoRoot: "/repos/draft-secret-worktree-root",
        path: "/state/worktrees/draft-secret-worktree-path",
        branch: "openclaw/draft-secret-worktree-branch",
        baseRef: "main",
        ownerKind: "session",
        ownerId: "agent:main:owned-draft",
        createdAt: 100,
        lastActiveAt: 490,
      },
      {
        id: "incognito-session-worktree",
        name: "incognito-secret-worktree-name",
        repoFingerprint: "incognito-secret-worktree-fingerprint",
        repoRoot: "/repos/incognito-secret-worktree-root",
        path: "/state/worktrees/incognito-secret-worktree-path",
        branch: "openclaw/incognito-secret-worktree-branch",
        baseRef: "main",
        ownerKind: "session",
        ownerId: "agent:main:dashboard:incognito-private",
        createdAt: 100,
        lastActiveAt: 480,
      },
      {
        id: "orphan-session-worktree",
        name: "orphan-secret-worktree-name",
        repoFingerprint: "orphan-secret-worktree-fingerprint",
        repoRoot: "/repos/orphan-secret-worktree-root",
        path: "/state/worktrees/orphan-secret-worktree-path",
        branch: "openclaw/orphan-secret-worktree-branch",
        baseRef: "main",
        ownerKind: "session",
        ownerId: "agent:main:missing-owner",
        createdAt: 100,
        lastActiveAt: 470,
      },
      {
        id: "ownerless-session-worktree",
        name: "ownerless-secret-worktree-name",
        repoFingerprint: "ownerless-secret-worktree-fingerprint",
        repoRoot: "/repos/ownerless-secret-worktree-root",
        path: "/state/worktrees/ownerless-secret-worktree-path",
        branch: "openclaw/ownerless-secret-worktree-branch",
        baseRef: "main",
        ownerKind: "session",
        createdAt: 100,
        lastActiveAt: 460,
      },
      {
        id: "manual-worktree",
        name: "manual-secret-worktree-name",
        repoFingerprint: "manual-secret-worktree-fingerprint",
        repoRoot: "/repos/manual-secret-worktree-root",
        path: "/state/worktrees/manual-secret-worktree-path",
        branch: "openclaw/manual-secret-worktree-branch",
        baseRef: "main",
        ownerKind: "manual",
        createdAt: 100,
        lastActiveAt: 450,
      },
      {
        id: "workboard-worktree",
        name: "workboard-secret-worktree-name",
        repoFingerprint: "workboard-secret-worktree-fingerprint",
        repoRoot: "/repos/workboard-secret-worktree-root",
        path: "/state/worktrees/workboard-secret-worktree-path",
        branch: "openclaw/workboard-secret-worktree-branch",
        baseRef: "main",
        ownerKind: "workboard",
        ownerId: "card-secret-owner",
        createdAt: 100,
        lastActiveAt: 440,
      },
    ] as const;
    const handlers = createProjectsHandlers({
      list: vi.fn(async () => [...worktrees]),
      resolveRepositoryIdentity,
    } as never);
    const config: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true }] },
    };
    const listFor = async (client?: GatewayClient) => {
      const respond = vi.fn();
      await handlers["projects.list"]?.({
        params: {},
        respond,
        context: { getRuntimeConfig: () => config } as GatewayRequestContext,
        client,
      } as never);
      return respond.mock.calls[0]?.[1]?.projects as Array<{
        name: string;
        originUrl?: string;
        checkouts: Array<{ path: string }>;
      }>;
    };

    const viewerProjects = await listFor(authenticatedClient("viewer@example.com"));
    expect(viewerProjects.map((project) => project.name)).toEqual([
      "visible-session-owned",
      "ordinary-visible",
    ]);
    const viewerPayload = JSON.stringify(viewerProjects);
    expect(viewerPayload).not.toContain("draft-secret-name");
    expect(viewerPayload).not.toContain("incognito-secret-name");
    expect(viewerPayload).not.toContain("draft-secret-worktree");
    expect(viewerPayload).not.toContain("incognito-secret-worktree");
    expect(viewerPayload).not.toContain("orphan-secret-worktree");
    expect(viewerPayload).not.toContain("ownerless-secret-worktree");
    expect(viewerPayload).not.toContain("manual-secret-worktree");
    expect(viewerPayload).not.toContain("workboard-secret-worktree");
    expect(resolveRepositoryIdentity.mock.calls).toEqual([
      ["/repos/visible-session-root"],
      ["/repos/ordinary-visible"],
    ]);

    const ownerProjects = await listFor();
    expect(
      ownerProjects.flatMap((project) => project.checkouts.map((checkout) => checkout.path)),
    ).toEqual(expect.arrayContaining(worktrees.map((worktree) => worktree.path)));

    const adminProjects = await listFor(
      authenticatedClient("admin@example.com", ["operator.admin"]),
    );
    expect(
      adminProjects.flatMap((project) => project.checkouts.map((checkout) => checkout.path)),
    ).toEqual(expect.arrayContaining(worktrees.map((worktree) => worktree.path)));
  });

  it("removes credentials, queries, and fragments from public origin URLs", async () => {
    seededSessions.store = {
      "agent:main:credentials": {
        sessionId: "credentials",
        updatedAt: 300,
        execCwd: "/repos/credentials",
      },
      "agent:main:query": {
        sessionId: "query",
        updatedAt: 200,
        execCwd: "/repos/query",
      },
      "agent:main:scp": {
        sessionId: "scp",
        updatedAt: 100,
        execCwd: "/repos/scp",
      },
    };
    const origins: Record<string, string> = {
      "/repos/credentials": ["https://user", ":", "token", "@host/repo.git"].join(""),
      "/repos/query": "https://host/query.git?visible=value#branch",
      "/repos/scp": "git@host:org/scp.git",
    };
    const handlers = createProjectsHandlers({
      list: vi.fn(async () => []),
      resolveRepositoryIdentity: vi.fn(async (checkoutPath: string) => ({
        checkoutRoot: checkoutPath,
        repoRoot: checkoutPath,
        originUrl: origins[checkoutPath],
        fingerprint: checkoutPath,
      })),
    } as never);
    const respond = vi.fn();

    await handlers["projects.list"]?.({
      params: {},
      respond,
      context: {
        getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
      } as GatewayRequestContext,
    } as never);

    const projects = respond.mock.calls[0]?.[1]?.projects as Array<{
      name: string;
      originUrl: string;
    }>;
    expect(projects.map(({ name, originUrl }) => ({ name, originUrl }))).toEqual([
      { name: "credentials", originUrl: "https://host/repo.git" },
      { name: "query", originUrl: "https://host/query.git" },
      { name: "scp", originUrl: "git@host:org/scp.git" },
    ]);
  });

  it("caps same-project checkouts in deterministic newest-first order", async () => {
    seededSessions.store = {};
    const worktrees = Array.from(
      { length: PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT + 3 },
      (_, index) => ({
        id: `worktree-${index}`,
        name: `worktree-${index}`,
        repoFingerprint: "alpha-fingerprint",
        repoRoot: "/repos/alpha",
        path: `/state/worktrees/alpha/worktree-${String(index).padStart(2, "0")}`,
        branch: `openclaw/worktree-${index}`,
        baseRef: "main",
        ownerKind: "manual" as const,
        createdAt: 1,
        lastActiveAt: index >= PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT + 1 ? 1_000 : index,
      }),
    ).toReversed();
    const handlers = createProjectsHandlers({
      list: vi.fn(async () => worktrees),
      resolveRepositoryIdentity: vi.fn(async (checkoutPath: string) => ({
        checkoutRoot: checkoutPath,
        repoRoot: checkoutPath,
        originUrl: "https://github.com/openclaw/alpha.git",
        fingerprint: "alpha-fingerprint",
      })),
    } as never);
    const respond = vi.fn();

    await handlers["projects.list"]?.({
      params: { limit: 1 },
      respond,
      context: {
        getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
      } as GatewayRequestContext,
    } as never);

    const checkouts = respond.mock.calls[0]?.[1]?.projects[0]?.checkouts as Array<{
      path: string;
    }>;
    expect(checkouts).toHaveLength(PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT);
    expect(checkouts.map((checkout) => checkout.path)).toEqual([
      "/state/worktrees/alpha/worktree-51",
      "/state/worktrees/alpha/worktree-52",
      ...Array.from(
        { length: 48 },
        (_, index) => `/state/worktrees/alpha/worktree-${String(50 - index).padStart(2, "0")}`,
      ),
    ]);
  });

  it("caps identity probes to the newest four candidates for limit one", async () => {
    seededSessions.store = Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => {
        const ordinal = index + 1;
        return [
          `agent:main:stale-${ordinal}`,
          {
            sessionId: `stale-${ordinal}`,
            updatedAt: ordinal,
            execCwd: `/repos/stale-${ordinal}`,
          },
        ];
      }),
    );
    const resolveRepositoryIdentity = vi.fn(async () => {
      throw new Error("checkout is unavailable");
    });
    const handlers = createProjectsHandlers({
      list: vi.fn(async () => []),
      resolveRepositoryIdentity,
    } as never);
    const respond = vi.fn();

    await handlers["projects.list"]?.({
      params: { limit: 1 },
      respond,
      context: {
        getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
      } as GatewayRequestContext,
    } as never);

    expect(respond).toHaveBeenCalledWith(true, { projects: [] }, undefined);
    expect(resolveRepositoryIdentity.mock.calls).toEqual([
      ["/repos/stale-7"],
      ["/repos/stale-6"],
      ["/repos/stale-5"],
      ["/repos/stale-4"],
    ]);
  });

  it("rejects an out-of-range limit", async () => {
    const handlers = createProjectsHandlers({
      list: vi.fn(async () => []),
      resolveRepositoryIdentity: vi.fn(),
    } as never);
    const respond = vi.fn();

    await handlers["projects.list"]?.({ params: { limit: 201 }, respond } as never);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("invalid projects.list params") }),
    );
  });
});
