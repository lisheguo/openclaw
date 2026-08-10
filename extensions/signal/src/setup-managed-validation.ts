import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { resolveSignalAccount, resolveSignalTransport } from "./accounts.js";
import { spawnSignalDaemon } from "./daemon.js";
import { assertSignalSetupDaemonBindAvailable } from "./setup-daemon-bind.js";
import {
  probeSignalTransport,
  resolveConfiguredSignalTransport,
  type SignalManagedNativeTransport,
  type SignalTransportProbeResult,
} from "./setup-transport.js";
import { buildSignalTransportHttpUrl } from "./transport-url.js";

type ResolvedManagedSignalTransport = Extract<
  ReturnType<typeof resolveSignalTransport>,
  { kind: "managed-native" }
>;

function sameManagedTransport(
  left: ResolvedManagedSignalTransport,
  right: ResolvedManagedSignalTransport,
): boolean {
  return (
    left.cliPath === right.cliPath &&
    left.configPath === right.configPath &&
    left.httpHost === right.httpHost &&
    left.httpPort === right.httpPort &&
    left.baseUrl === right.baseUrl &&
    left.startupTimeoutMs === right.startupTimeoutMs &&
    left.receiveMode === right.receiveMode &&
    left.ignoreStories === right.ignoreStories
  );
}

export function managedSignalTransportIdentity(transport: SignalManagedNativeTransport): string {
  const resolved = resolveSignalTransport(transport);
  if (resolved.kind !== "managed-native") {
    throw new Error("Signal setup did not resolve a managed signal-cli transport.");
  }
  return JSON.stringify({
    cliPath: resolved.cliPath,
    configPath: resolved.configPath,
    httpHost: resolved.httpHost,
    httpPort: resolved.httpPort,
    baseUrl: resolved.baseUrl,
    startupTimeoutMs: resolved.startupTimeoutMs,
    receiveMode: resolved.receiveMode,
    ignoreStories: resolved.ignoreStories,
  });
}

async function probeManagedBind(params: {
  cfg: OpenClawConfig;
  accountId: string;
  transport: SignalManagedNativeTransport;
  resolved: ResolvedManagedSignalTransport;
  account: string;
}): Promise<SignalTransportProbeResult> {
  return await probeSignalTransport({
    cfg: params.cfg,
    accountId: params.accountId,
    transport: {
      ...params.transport,
      httpHost: params.resolved.httpHost,
      httpPort: params.resolved.httpPort,
      url: buildSignalTransportHttpUrl(params.resolved.httpHost, params.resolved.httpPort),
    },
    account: params.account,
    nativeAccountBinding: "owner-known-bound-account",
    timeoutMs: 1_000,
  }).catch((error: unknown) => ({ ok: false, error: String(error) }));
}

async function probeSeparateConnectionUrl(params: {
  cfg: OpenClawConfig;
  accountId: string;
  transport: SignalManagedNativeTransport;
  resolved: ResolvedManagedSignalTransport;
  account: string;
}): Promise<SignalTransportProbeResult> {
  const bindUrl = buildSignalTransportHttpUrl(params.resolved.httpHost, params.resolved.httpPort);
  if (params.resolved.baseUrl === bindUrl) {
    return { ok: true, status: 200, error: null };
  }
  return await probeSignalTransport({
    cfg: params.cfg,
    accountId: params.accountId,
    transport: params.transport,
    account: params.account,
    timeoutMs: 1_000,
  }).catch((error: unknown) => ({ ok: false, error: String(error) }));
}

export async function probeManagedSignalSetup(params: {
  cfg: OpenClawConfig;
  accountId: string;
  transport: SignalManagedNativeTransport;
  account: string;
  reusableConfiguredAccount?: string;
  reusableConfiguredTransport?: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
}): Promise<SignalTransportProbeResult> {
  const resolved = resolveSignalTransport(params.transport);
  if (resolved.kind !== "managed-native") {
    throw new Error("Signal setup did not resolve a managed signal-cli transport.");
  }
  const progress = params.prompter.progress("Validating Signal setup...");
  let daemon: ReturnType<typeof spawnSignalDaemon> | undefined;
  let result: SignalTransportProbeResult = { ok: false, error: "Signal transport probe failed." };
  try {
    const configured = resolveConfiguredSignalTransport(params.cfg, params.accountId);
    const configuredAccount = normalizeOptionalString(
      resolveSignalAccount({ cfg: params.cfg, accountId: params.accountId }).config.account,
    );
    if (
      configured?.kind === "managed-native" &&
      configuredAccount === params.account &&
      params.reusableConfiguredAccount === params.account &&
      params.reusableConfiguredTransport === managedSignalTransportIdentity(configured)
    ) {
      const configuredResolved = resolveSignalTransport(configured);
      if (
        configuredResolved.kind === "managed-native" &&
        sameManagedTransport(configuredResolved, resolved)
      ) {
        result = await probeManagedBind({ ...params, resolved });
        if (result.ok) {
          result = await probeSeparateConnectionUrl({ ...params, resolved });
          return result;
        }
      }
    }

    await assertSignalSetupDaemonBindAvailable({
      httpHost: resolved.httpHost,
      httpPort: resolved.httpPort,
    });
    const spawnedDaemon = spawnSignalDaemon({
      cliPath: resolved.cliPath,
      ...(resolved.configPath ? { configPath: resolved.configPath } : {}),
      account: params.account,
      httpHost: resolved.httpHost,
      httpPort: resolved.httpPort,
      // Setup proof must not drain messages before the real monitor owns delivery.
      receiveMode: "manual",
      ...(typeof resolved.ignoreStories === "boolean"
        ? { ignoreStories: resolved.ignoreStories }
        : {}),
    });
    daemon = spawnedDaemon;
    await waitForTransportReady({
      label: "signal-cli setup daemon",
      timeoutMs: Math.min(120_000, Math.max(1_000, resolved.startupTimeoutMs)),
      logAfterMs: 10_000,
      logIntervalMs: 10_000,
      pollIntervalMs: 150,
      runtime: params.runtime,
      check: async () => {
        if (spawnedDaemon.isExited()) {
          throw new Error("signal-cli exited before its HTTP server became ready.");
        }
        result = await probeManagedBind({ ...params, resolved });
        return result;
      },
    });
    if (result.ok) {
      result = await probeSeparateConnectionUrl({ ...params, resolved });
    }
    return result;
  } catch (error) {
    result = { ok: false, error: String(error) };
    return result;
  } finally {
    try {
      await daemon?.stop();
    } finally {
      progress.stop(result.ok ? "Signal setup validated." : "Signal setup validation failed.");
    }
  }
}
