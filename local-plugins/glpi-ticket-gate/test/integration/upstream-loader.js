import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

// Execute unchanged pinned upstream TypeScript in memory. No Core edits,
// install, build, Gateway, GLPI, transport, model or production configuration.
// Every substituted service is explicit. This is COMPONENT integration, not
// a full runEmbeddedAgent / Gateway / plugin-loader acceptance test.
export async function upstreamFixture({ substitutions = {}, realModules = [] } = {}) {
  const root = process.env.OPENCLAW_SOURCE;
  if (!root) throw new Error('Set OPENCLAW_SOURCE to the pinned v2026.9.9 checkout');
  const lock = JSON.parse(readFileSync(new URL('./source-lock.json', import.meta.url)));
  const loaded = new Map(); const cache = new Map(); const logs = [];
  const context = vm.createContext({ console, structuredClone, setTimeout, clearTimeout,
    setImmediate, clearImmediate, queueMicrotask, AbortController, AbortSignal, Buffer, URL,
    TextEncoder, TextDecoder, performance });
  const logger = { warn: s => logs.push(s), error: s => logs.push(s), debug: () => {},
    info: () => {}, trace: () => {}, isEnabled: () => false };
  const unavailable = label => () => { throw new Error(`Unexercised fixture boundary: ${label}`); };
  let runner;
  const stubs = new Map(Object.entries({
    'src/agents/hook-system-context-boundary.ts': { wrapPluginSystemContextSection: value => {
      if (value) throw new Error('System-context fixture boundary');
      return undefined;
    } },
    'src/agents/usage.ts': { deriveContextPromptTokens: unavailable('usage') },
    'src/config/io.invalid-config.ts': { isInvalidConfigError: () => false },
    'src/infra/errno.ts': { hasErrnoCode: unavailable('errno'), isErrno: unavailable('errno'), isMissingPathError: unavailable('errno') },
    'src/utils/with-timeout.ts': { withTimeout: unavailable('middleware timeout') },
    'src/plugins/runtime.ts': { getActivePluginRegistry: unavailable('active registry') },
    'src/logging/redact.ts': { redactSensitiveText: () => '[fixture-error]' },
    'src/globals.ts': { logVerbose: () => {} },
    'src/logging/subsystem.ts': { createSubsystemLogger: () => logger },
    'src/plugins/hook-runner-global.ts': { getGlobalHookRunner: () => runner },
    'src/audit/runtime-action-decision.ts': { recordRuntimeActionDecision: unavailable('audit') },
    'src/auto-reply/group-thread-context.ts': { finalizeGroupThreadToolReply: unavailable('group reply') },
    'src/plugins/hook-reply-payload.ts': { acceptPluginReplyPayload: unavailable('reply payload'), toPluginReplyPayload: unavailable('reply payload') },
    'src/plugins/plugin-instance-scope.ts': { runPluginCleanup: unavailable('cleanup'), getPluginInstance: () => undefined },
    'src/plugins/runtime/subagent-requester-context.ts': { withPluginSubagentRequesterContext: unavailable('subagent') },
    'src/plugins/runtime/gateway-request-scope.ts': { withPluginRuntimePluginScope: (_scope, run) => run() },
    'src/plugins/registry-lifecycle.ts': { capturePluginLifecycleAuthority: unavailable('real plugin lifecycle') },
    'src/plugins/model-catalog-registration.ts': { createModelCatalogRegistrationHandlers: unavailable('model catalog') },
    'src/plugins/native-session-catalog-registration.ts': { createNativeSessionCatalogGate: unavailable('native session catalog') },
    'src/plugins/registry-runtime-binding.ts': { bindPluginRegistryRuntime: unavailable('registry runtime') },
    'src/plugins/codex-app-server-extension-factory.ts': { CODEX_APP_SERVER_EXTENSION_RUNTIME_ID: 'codex-app-server' },
    'src/plugins/host-hook-state.ts': { drainPluginNextTurnInjectionContext: async () => ({ queuedInjections: [] }) },
    'src/agents/bash-process-references.ts': { listActiveProcessSessionReferences: unavailable('process references') },
    'src/agents/bash-process-scope.ts': { resolveProcessToolScopeKey: unavailable('process scope') },
    'src/agents/tool-fs-policy.ts': { resolveEffectiveToolFsWorkspaceOnly: unavailable('tool fs policy') },
    'src/agents/embedded-agent-runner/compaction-runtime-context.ts': { buildEmbeddedCompactionRuntimeContext: unavailable('compaction') },
    'src/agents/embedded-agent-runner/context-engine-capabilities.ts': { resolveContextEngineCapabilities: unavailable('context engine') },
  }));
  for (const file of realModules) stubs.delete(file);
  for (const [file, exports] of Object.entries(substitutions)) stubs.set(file, exports);
  // Leaf aliases refer to real source; this replaces package resolution only.
  const aliases = new Map([
    ['src/agents/tool-policy.ts', 'src/agents/tool-policy-shared.ts'],
    ['src/utils.ts', 'packages/normalization-core/src/utf16-slice.ts'],
  ]);
  async function moduleFor(specifier, parent = '') {
    if (specifier.startsWith('node:')) {
      if (!['node:async_hooks', 'node:crypto', 'node:path', 'node:util', 'node:events'].includes(specifier)) {
        throw new Error(`Disallowed native dependency: ${specifier} from ${parent}`);
      }
      if (!cache.has(specifier)) {
        const exports = await import(specifier);
        cache.set(specifier, new vm.SyntheticModule(Object.keys(exports), function () {
          for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context, identifier: specifier }));
      }
      return cache.get(specifier);
    }
    let file;
    if (specifier.startsWith('@openclaw/normalization-core/')) {
      file = `packages/normalization-core/src/${specifier.split('/').at(-1)}.ts`;
    } else if (specifier === '@openclaw/normalization-core') {
      // This fixture only consumes expectDefined from the aggregate facade.
      file = 'packages/normalization-core/src/expect.ts';
    } else if (/^@openclaw\/(media-core|model-catalog-core)\//.test(specifier)) {
      const [pkg, leaf] = specifier.slice('@openclaw/'.length).split('/');
      file = `packages/${pkg}/src/${leaf}.ts`;
    } else if (specifier.startsWith('openclaw/plugin-sdk/') && specifier !== 'openclaw/plugin-sdk/text-utility-runtime') {
      file = `src/plugin-sdk/${specifier.split('/').at(-1)}.ts`;
    } else if (specifier === 'openclaw/plugin-sdk/text-utility-runtime') {
      file = 'packages/normalization-core/src/utf16-slice.ts';
    } else if (specifier === '@openclaw/session-url-contract') {
      file = 'packages/session-url-contract/src/index.ts';
    } else if (specifier.startsWith('@openclaw/session-url-contract/')) {
      file = `packages/session-url-contract/src/${specifier.split('/').at(-1)}.ts`;
    } else if (specifier.startsWith('.')) {
      file = path.posix.normalize(path.posix.join(path.posix.dirname(parent), specifier)).replace(/\.js$/, '.ts');
    } else if (/^(src|packages|extensions)\//.test(specifier)) file = specifier;
    else throw new Error(`Unresolved external dependency: ${specifier} from ${parent}`);
    file = aliases.get(file) ?? file;
    if (file.startsWith('../')) throw new Error('Upstream path escapes checkout');
    if (cache.has(file)) return cache.get(file);
    let mod;
    if (stubs.has(file)) {
      const exports = stubs.get(file);
      mod = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context, identifier: file });
    } else {
      const source = readFileSync(path.join(root, file), 'utf8');
      const hash = createHash('sha256').update(source).digest('hex');
      if (lock.files[file] !== hash) throw new Error(`Pinned source mismatch: ${file}`);
      loaded.set(file, hash);
      mod = new vm.SourceTextModule(stripTypeScriptTypes(source, { mode: 'transform' }), {
        context, identifier: file,
      });
    }
    cache.set(file, mod);
    return mod;
  }
  async function load(file) {
    const mod = await moduleFor(file);
    if (mod.status === 'unlinked') await mod.link((s, ref) => moduleFor(s, ref.identifier));
    if (mod.status === 'linked') await mod.evaluate();
    return mod.namespace;
  }
  return { load, logs, loaded, stubs, setRunner: value => { runner = value; } };
}
