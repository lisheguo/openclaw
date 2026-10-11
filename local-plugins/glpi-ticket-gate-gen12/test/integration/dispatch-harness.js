import { readFileSync } from 'node:fs';
import { dispatchFixtureSource } from './dispatch-loader.js';
import { createFlowStore } from '../../lib/state.js';
import { createFlowGatedToolFactory } from '../../lib/tool.js';
import { handlePromptBuild } from '../../lib/handlers.js';
import { createDispatchPreparation, registerDispatchPrototype } from '../support/before-dispatch-prototype.js';

export async function loadDispatchHarness() {
  const u = await dispatchFixtureSource();
  const { createEmptyPluginRegistry } = await u.load('src/plugins/registry-empty.ts');
  const { createToolHookRegistrars } = await u.load('src/plugins/registry-registrars-tools-hooks.ts');
  const { createHookRunner } = await u.load('src/plugins/hooks.ts');
  const { createPluginToolFactoryResolver } = await u.load('src/plugins/tool-factory-runtime.ts');
  const { resolvePromptBuildHookResult } = await u.load('src/agents/embedded-agent-runner/run/attempt-prompt-helpers.ts');
  const { buildFeishuAgentBody } = await u.load('extensions/feishu/src/bot-agent-body.ts');
  const { buildChannelInboundEventContext } = await u.load('src/channels/inbound-event/context.ts');
  const { deriveInboundMessageHookContext, toPluginInboundClaimPair } = await u.load('src/hooks/message-hook-mappers.ts');
  const { emitMessageReceivedHooks } = await u.load('src/auto-reply/reply/message-received-hooks.ts');
  const { chooseDispatchRoute } = await u.load('src/auto-reply/reply/dispatch-from-config.choose-route.ts');
  const manifest = JSON.parse(readFileSync(new URL('../../openclaw.plugin.json', import.meta.url)));

  function inbound({ content = '新增工单', quote, name = 'fixture display', sender = 'fixture-a',
    message = 'fixture-message', account = 'fixture-account', session = 'fixture-session',
    chat = 'fixture-chat', thread, kind = 'group', audioTranscript, channel = 'feishu', mention = false, extra = {} } = {}) {
    const command = audioTranscript ?? content; // bot.ts's producer choice; no ASR/network.
    const rendered = buildFeishuAgentBody({ ctx: { content: command, senderName: name, senderOpenId: sender,
      messageId: message, hasAnyMention: mention }, quotedContent: quote });
    return buildChannelInboundEventContext({
      channel, accountId: account, from: `fixture:${sender}`, messageId: message,
      sender: { id: sender, name }, conversation: { kind, id: chat, label: kind === 'group' ? chat : undefined, nativeChannelId: chat, threadId: thread },
      route: { agentId: 'fixture-agent', routeSessionKey: session, accountId: account },
      reply: { to: chat, replyToId: quote ? 'fixture-quoted-message' : undefined, messageThreadId: thread },
      message: { body: `[fixture history: 新增工单]\n${rendered}`, bodyForAgent: rendered, rawBody: command, commandBody: command },
      supplemental: { quote: quote ? { id: 'fixture-quoted-message', body: quote } : undefined },
      extra,
    });
  }

  function create({ ledger = createDispatchPreparation(), conversationAccess = false } = {}) {
    const registry = createEmptyPluginRegistry(); const trace = []; const prepared = []; const seen = []; const observed = [];
    const record = { id: manifest.id, origin: 'global', explicitlyEnabled: true, enabled: true,
      status: 'loaded', hookCount: 0, toolNames: [], contracts: manifest.contracts, source: 'fixture' };
    registry.plugins.push(record);
    const noop = () => {}; const logger = { info: noop, debug: noop, warn: noop, error: noop };
    const registrars = createToolHookRegistrars({ registry, registryParams: { logger },
      pluginsWithChannelRegistrationConflict: new Set(),
      createRegistration: (r, value) => ({ pluginId: r.id, source: r.source, ...value }),
      reportRegistrationWarning: noop, reportRegistrationError: (_r, text) => { throw new Error(text); },
    });
    const api = { on: (name, fn, options) => registrars.registerTypedHook(record,name,fn,options,{ allowConversationAccess: conversationAccess }),
      registerTool: (factory, options) => registrars.registerTool(record,factory,options) };
    registerDispatchPrototype(api, ledger, result => { trace.push('prepared'); prepared.push(result); });
    api.on('before_dispatch', (event, ctx) => { seen.push({ event, ctx }); return { handled: false }; });
    api.on('message_received', (event, ctx) => { observed.push({ event, ctx }); });
    const activeStore = createFlowStore();
    const deps = { store: activeStore, log: logger, cfg: {}, readSkill: () => ({ ok: true, sha256: 'fixture', text: 'fixture GLPI Skill' }) };
    api.registerTool(createFlowGatedToolFactory(deps), { name: 'glpi_ticket_preflight' });
    // Prompt handler is the current plugin implementation; explicit permission
    // enables this probe only. before_dispatch itself has no conversation gate.
    registrars.registerTypedHook(record, 'before_prompt_build', (_event, ctx) => {
      const result = handlePromptBuild(deps, ctx);
      return result.injected ? { prependContext: result.prependContext } : undefined;
    }, undefined, { allowConversationAccess: true });
    const runner = createHookRunner(registry, { logger, catchErrors: true });
    const resolver = createPluginToolFactoryResolver(error => { throw new Error(error); });
    function factory(ctx) {
      const entry = registry.tools[0];
      const result = resolver.resolve(entry, { sessionKey: ctx.SessionKey, requesterSenderId: ctx.SenderId,
        messageChannel: ctx.Provider, agentAccountId: ctx.AccountId }, entry.names, registry);
      if (result.failed) throw new Error('Factory fixture failed');
      return result.resolved;
    }
    async function readiness(ctx) {
      const firstTool = factory(ctx);
      const prompt = await resolvePromptBuildHookResult({ config: {}, prompt: ctx.agentText, messages: [],
        hookCtx: { sessionKey: ctx.SessionKey, senderId: ctx.SenderId, runId: 'fixture-run-not-message-id', trigger: 'user' }, hookRunner: runner });
      return { flow: Boolean(activeStore.get(ctx.SessionKey,ctx.SenderId)), tool: Boolean(firstTool), skill: Boolean(prompt.prependContext) };
    }
    function observation(ctx) {
      let resolve; const done = new Promise(r => { resolve = r; });
      const hookRunner = { hasHooks: runner.hasHooks, runMessageReceived: async (...args) => {
        try { return await runner.runMessageReceived(...args); } finally { resolve(); }
      } };
      // sessionKey undefined suppresses only the unrelated internal Hook. The
      // real mapper still obtains the plugin event session from ctx.SessionKey.
      emitMessageReceivedHooks({ ctx, hookRunner, sessionKey: undefined });
      return done;
    }
    async function dispatch(ctx, { status = 'accepted', allow = true, settings, signal, takeover = false } = {}) {
      const hookContext = deriveInboundMessageHookContext(ctx);
      const pair = toPluginInboundClaimPair(hookContext);
      return chooseDispatchRoute({
        ctx, hookRunner: runner, hookState: { hookContext, inboundClaimContext: pair.context },
        sessionKey: ctx.SessionKey, sessionStoreEntry: { sessionKey: ctx.SessionKey },
        params: { replyOptions: { admittedSessionSettings: settings } },
        cfg: {}, dispatcher: { getQueuedCounts: () => ({ final: 0, tool: 0, block: 0 }) },
        replyRoute: { accountId: ctx.AccountId }, replyContextAccountId: ctx.AccountId,
        routeReplyChannel: 'feishu', routeReplyTo: ctx.ChatId, routeReplyThreadId: ctx.MessageThreadId,
        allowInboundHandlers: allow, fixtureTakeover: takeover,
        traceReplyPhase: (_name, run) => run(), runWithDispatchLifecycleAdmission: run => run(),
        getPreDispatchAbortSignal: () => signal, trackDispatchLifecycleWork: noop,
        assertCurrentBindingRoute: async () => { if (signal?.aborted) throw new Error('stale fixture route'); },
        ensureDispatchReplyOperation: async () => { trace.push('admission'); return { status }; },
        finishReplyOperationAbortedDispatch: () => ({ fixture: 'aborted' }),
        finishReplyOperationBusyDispatch: () => ({ fixture: 'busy' }),
        attachSourceReplyDeliveryMode: result => result,
        recordProcessed: noop, markIdle: noop, commitInboundDedupeIfClaimed: noop, completeDispatchReplyOperation: noop,
        shouldEmitVerboseProgress: () => false,
      });
    }
    return { api, registry, ledger, trace, prepared, seen, observed, runner, factory, readiness, dispatch, observation, activeStore, deps };
  }
  return { u, inbound, create };
}
