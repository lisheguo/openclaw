import { upstreamFixture } from './upstream-loader.js';

// These boundaries perform delivery, filesystem/media I/O, or host ownership.
// The actual builder/finalizer/mapper/chooseDispatchRoute/hook runner execute.
// No fixture claims to authenticate a real Feishu transport or run a Gateway.
export async function dispatchFixtureSource() {
  const unused = name => () => { throw new Error(`Unexercised dispatch boundary: ${name}`); };
  const forbidden = names => Object.fromEntries(names.map(name => [name, unused(name)]));
  return upstreamFixture({
    realModules: ['src/plugins/runtime/subagent-requester-context.ts'],
    substitutions: {
      'src/utils/message-channel-core.ts': {
        normalizeMessageChannel: value => typeof value === 'string' ? value.trim().toLowerCase() : undefined,
        isNormalizedMessageChannel: value => value === 'feishu',
      },
      'src/channels/inbound-event/host-context-builder.ts': {
        createHostChannelInboundEventContextBuilder: () => unused('host ingress authentication'),
      },
      'src/channels/plugins/index.ts': { getChannelPlugin: () => undefined, normalizeChannelId: s => s },
      'src/media/media-probe.ts': { probeMediaFilesWithinBudget: unused('media file probing') },
      'src/media/local-media-path.ts': { resolveLocalMediaPath: unused('media local path') },
      'src/plugin-sdk/reply-payload.ts': forbidden(['hasOutboundReplyContent', 'resolveSendableOutboundReplyParts']),
      'src/tts/captioned-final.ts': { ...forbidden(['buildCaptionedFinalTextFallback','cleanDeferredFinalText','isCaptionedFinalTextPayload','mergeDeferredFinalText']), shouldDeferFinalTtsText: () => false },
      'src/tts/tts-config.ts': { shouldCleanTtsDirectiveText: () => false },
      'src/auto-reply/dispatch-dispatcher.ts': forbidden(['registerReplyDispatcherSettledTask']),
      'src/auto-reply/reply-payload.ts': forbidden(['copyReplyPayloadMetadata','getReplyPayloadMetadata','setReplyPayloadMetadata']),
      'src/auto-reply/reply/agent-runner-failure-reply.ts': forbidden(['renderPostCompactionModelFailurePayload']),
      'src/auto-reply/reply/block-reply-delivery.ts': forbidden(['recoverBlockReplySources','setBlockReplyDelivery']),
      'src/auto-reply/reply/block-reply-pipeline.ts': forbidden(['createBlockReplyContentKey']),
      'src/auto-reply/reply/dispatch-from-config.payloads.ts': forbidden(['hasExecApprovalPayload','requiresDurableToolResultDelivery']),
      'src/auto-reply/reply/dispatch-from-config.pending-final.ts': forbidden(['suppressPendingFinalDelivery']),
      'src/auto-reply/reply/dispatch-from-config.reply-dispatch-hook.ts': {
        runReplyDispatchTakeover: async state => state.fixtureTakeover ? { status: 'complete', result: { takeover: true } } : undefined,
      },
      'src/auto-reply/reply/dispatch-from-config.restricted-runtime.ts': { maybeRefuseRestrictedRuntimeTakeover: async () => undefined },
      'src/auto-reply/reply/dispatch-from-config.transcript.ts': forbidden(['captureDeliveredTranscriptMirror','mirrorDeliveredReplyToTranscript','mirrorTranscriptAfterDispatcherSettled','transcriptMirrorForDeliveredPayload']),
      'src/auto-reply/reply/reply-dispatch-outcome.ts': forbidden(['resolveRoutedReplyDeliveryOutcome','shouldRetryReplyDispatch']),
      'src/auto-reply/reply/reply-dispatcher.ts': forbidden(['attachReplyDispatchUndeliveredFallback','prepareReplyPayloadForDispatcher']),
      'src/auto-reply/reply/session-writer-delivery-authority.ts': forbidden(['isDispatchFinalReplySessionWriterAuthorized']),
      'src/auto-reply/reply/dispatch-from-config.runtime.ts': forbidden(['createInternalHookEvent','triggerInternalHook']),
    },
  });
}
