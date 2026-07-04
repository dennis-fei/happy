/**
 * API Chat Session Runner
 *
 * Entry point for generic OpenAI-compatible API chat sessions, following
 * the runOpenClaw.ts pattern. Instead of spawning a local agent process,
 * this connects directly to a chat completions API and forwards the
 * conversation through the Happy session pipeline so it can be viewed
 * and controlled from the mobile app.
 */

import { randomUUID } from 'node:crypto';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { encodeBase64 } from '@/api/encryption';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { connectionState } from '@/utils/serverConnectionErrors';
import { ApiChatBackend } from './ApiChatBackend';
import type { AgentMessage } from '@/agent/core';

export interface RunApiChatOptions {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  baseUrl: string;
  apiKey?: string;
  model: string;
  systemPrompt?: string;
  temperature?: number;
  verbose?: boolean;
}

export async function runApiChat(opts: RunApiChatOptions): Promise<void> {
  const verbose = opts.verbose === true;
  const sessionTag = randomUUID();
  connectionState.setBackend('apichat');

  const log = (msg: string) => {
    logger.debug(`[apichat] ${msg}`);
    if (verbose) {
      console.log(`[apichat] ${msg}`);
    }
  };

  log(`Base URL: ${opts.baseUrl}, model: ${opts.model}`);

  const api = await ApiClient.create(opts.credentials);
  const settings = await readSettings();
  if (!settings?.machineId) {
    throw new Error('No machine ID found in settings');
  }

  await api.getOrCreateMachine({
    machineId: settings.machineId,
    metadata: initialMachineMetadata,
  });

  const { state, metadata } = createSessionMetadata({
    flavor: 'apichat',
    machineId: settings.machineId,
    startedBy: opts.startedBy,
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
  if (response) {
    log(`Happy Session ID: ${response.id}`);
  }

  const sessionManager = new AcpSessionManager();
  const messageQueue = new MessageQueue2<Record<string, never>>(() => '');
  let shouldExit = false;
  let abortController = new AbortController();
  let thinking = false;
  let inTurn = false;
  let turnDone: (() => void) | null = null;

  /**
   * Register per-session listeners that must be re-applied whenever the session
   * object is swapped (offline → reconnected path via setupOfflineReconnection).
   * Not re-registering after a swap would cause the new session to never deliver
   * user messages to the message queue.
   */
  const registerSessionListeners = (s: ApiSessionClient) => {
    s.onUserMessage((message) => {
      if (!message.content.text) return;
      messageQueue.push(message.content.text, {});
    });
  };

  let session: ApiSessionClient;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
      registerSessionListeners(newSession);
    },
  });
  session = initialSession;
  registerSessionListeners(session);

  if (response) {
    try {
      await notifyDaemonSessionStarted(response.id, metadata, {
        encryptionKey: encodeBase64(response.encryptionKey),
        encryptionVariant: response.encryptionVariant,
        seq: response.seq,
        metadataVersion: response.metadataVersion,
        agentStateVersion: response.agentStateVersion,
      });
    } catch (error) {
      logger.debug('[apichat] Failed to report session to daemon:', error);
    }
  }

  const sendEnvelopes = (envelopes: SessionEnvelope[]) => {
    for (const envelope of envelopes) {
      session.sendSessionProtocolMessage(envelope);
    }
  };

  const backend = new ApiChatBackend({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    temperature: opts.temperature,
    log,
  });

  const onBackendMessage = (msg: AgentMessage) => {
    if (verbose && msg.type !== 'model-output') {
      log(`Backend message: ${JSON.stringify(msg).slice(0, 200)}`);
    }

    if (msg.type === 'status' && inTurn) {
      const nextThinking = msg.status === 'running';
      if (thinking !== nextThinking) {
        thinking = nextThinking;
        session.keepAlive(thinking, 'remote');
      }
      if (msg.status === 'idle') {
        turnDone?.();
      }
    }
    if (msg.type === 'status' && msg.status === 'error') {
      log(`Backend error: ${msg.detail ?? ''}`);
      shouldExit = true;
      messageQueue.close();
      turnDone?.();
    }

    sendEnvelopes(sessionManager.mapMessage(msg));
  };

  backend.onMessage(onBackendMessage);
  session.keepAlive(thinking, 'remote');

  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  async function handleAbort() {
    log('Abort requested');
    try {
      await backend.cancel('current');
    } catch (error) {
      logger.debug('[apichat] Abort failed:', error);
    }
    inTurn = false;
    thinking = false;
    session.keepAlive(false, 'remote');
    turnDone?.();
    abortController.abort();
    abortController = new AbortController();
  }

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, async () => {
    shouldExit = true;
    messageQueue.close();
    turnDone?.();
    await handleAbort();
  });

  try {
    const started = await backend.startSession();
    log(`Session ready: ${started.sessionId}`);

    while (!shouldExit) {
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (shouldExit) break;
        if (waitSignal.aborted) continue;
        break;
      }

      log(`Incoming prompt: ${batch.message.slice(0, 200)}`);
      inTurn = true;
      sendEnvelopes(sessionManager.startTurn());
      // turnDone is set synchronously inside new Promise before sendPrompt is
      // awaited, so onBackendMessage can never call turnDone?.() before it is
      // assigned (sendPrompt's internal async work fires after this tick).
      const turnEnded = new Promise<void>((resolve) => {
        turnDone = resolve;
      });
      try {
        // Note: the first argument (_sessionId) is unused by ApiChatBackend because
        // it is a single-session backend. It is kept for interface compatibility.
        await backend.sendPrompt(started.sessionId, batch.message);
        await turnEnded;
        sendEnvelopes(sessionManager.endTurn('completed'));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log(`Turn ended: ${msg}`);
        sendEnvelopes(sessionManager.endTurn('failed'));
      } finally {
        turnDone = null;
      }
      inTurn = false;
      thinking = false;
      session.keepAlive(false, 'remote');
      session.sendSessionEvent({ type: 'ready' });
    }
  } finally {
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();

    backend.offMessage(onBackendMessage);
    await backend.dispose();

    try {
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        lifecycleState: 'archived',
        lifecycleStateSince: Date.now(),
        archivedBy: 'cli',
        archiveReason: 'Session ended',
      }));
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (error) {
      logger.debug('[apichat] Session close failed:', error);
    }
  }
}
