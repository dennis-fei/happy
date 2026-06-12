/**
 * ApiChatBackend - Generic OpenAI-compatible chat API backend
 *
 * Talks directly to any OpenAI-compatible /chat/completions endpoint
 * (OpenAI, DeepSeek, Kimi, OpenRouter, Ollama, vLLM, ...) instead of
 * spawning a local agent process. Conversation history is kept in memory
 * for the lifetime of the session.
 *
 * Emits AgentMessage events compatible with AcpSessionManager mapping:
 * - status: starting | running | idle | error
 * - model-output: streaming text deltas
 */

import { randomUUID } from 'node:crypto';
import type { SessionId } from '@/agent/core';
import type { AgentMessage } from '@/agent/core';

export interface ApiChatBackendOptions {
  /** Base URL of the OpenAI-compatible API, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** API key (sent as Bearer token). Optional for local servers like Ollama. */
  apiKey?: string;
  /** Model identifier, e.g. gpt-4o-mini, deepseek-chat, llama3 */
  model: string;
  /** Optional system prompt prepended to the conversation */
  systemPrompt?: string;
  /** Sampling temperature */
  temperature?: number;
  /** Logger callback */
  log?: (msg: string) => void;
}

export interface StartSessionResult {
  sessionId: SessionId;
}

type AgentMessageHandler = (msg: AgentMessage) => void;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class ApiChatBackend {
  private readonly opts: ApiChatBackendOptions;
  private readonly handlers = new Set<AgentMessageHandler>();
  private readonly history: ChatMessage[] = [];
  private sessionId: SessionId | null = null;
  private currentRequest: AbortController | null = null;
  private disposed = false;

  constructor(opts: ApiChatBackendOptions) {
    this.opts = opts;
    if (opts.systemPrompt) {
      this.history.push({ role: 'system', content: opts.systemPrompt });
    }
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.add(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers.delete(handler);
  }

  private emit(msg: AgentMessage): void {
    for (const handler of this.handlers) {
      try {
        handler(msg);
      } catch (error) {
        this.log(`Handler error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  async startSession(): Promise<StartSessionResult> {
    if (this.disposed) {
      throw new Error('Backend already disposed');
    }
    this.emit({ type: 'status', status: 'starting' });
    this.sessionId = randomUUID();
    this.emit({ type: 'status', status: 'idle' });
    return { sessionId: this.sessionId };
  }

  /**
   * Send a user prompt and stream the assistant response.
   * Resolves when the full response has been received (turn end).
   * API errors do not kill the session - they are reported as output
   * and the turn ends in idle state.
   */
  async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
    if (this.disposed) {
      throw new Error('Backend already disposed');
    }

    this.history.push({ role: 'user', content: prompt });
    this.emit({ type: 'status', status: 'running' });

    const abort = new AbortController();
    this.currentRequest = abort;
    let assistantText = '';

    try {
      const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.opts.apiKey) {
        headers['Authorization'] = `Bearer ${this.opts.apiKey}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        signal: abort.signal,
        body: JSON.stringify({
          model: this.opts.model,
          messages: this.history,
          stream: true,
          ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`API error ${response.status}: ${body.slice(0, 500)}`);
      }
      if (!response.body) {
        throw new Error('API returned empty response body');
      }

      assistantText = await this.consumeSseStream(response.body, abort.signal);

      if (assistantText) {
        this.history.push({ role: 'assistant', content: assistantText });
      }
    } catch (error) {
      if (abort.signal.aborted) {
        this.log('Request aborted');
        if (assistantText) {
          this.history.push({ role: 'assistant', content: assistantText });
        }
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        this.log(`Request failed: ${msg}`);
        // Surface the error in the chat instead of killing the session
        this.emit({ type: 'model-output', textDelta: `\n[apichat error] ${msg}\n` });
        this.emit({ type: 'event', name: 'apichat-error', payload: { message: msg } });
        // Keep history consistent: drop the user message that failed
        if (this.history[this.history.length - 1]?.role === 'user') {
          this.history.pop();
        }
      }
    } finally {
      this.currentRequest = null;
      this.emit({ type: 'status', status: 'idle' });
    }
  }

  /**
   * Parse an SSE stream of OpenAI chat completion chunks.
   * Returns the accumulated assistant text.
   */
  private async consumeSseStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    try {
      while (true) {
        if (signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by double newlines; lines start with "data: "
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            return fullText;
          }

          try {
            const parsed = JSON.parse(data);
            const delta: string | undefined = parsed?.choices?.[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              this.emit({ type: 'model-output', textDelta: delta });
            }
          } catch {
            this.log(`Failed to parse SSE chunk: ${data.slice(0, 200)}`);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    return fullText;
  }

  /** Abort the in-flight request, if any. */
  async cancel(_sessionId: SessionId): Promise<void> {
    this.currentRequest?.abort();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.currentRequest?.abort();
    this.emit({ type: 'status', status: 'stopped' });
    this.handlers.clear();
  }
}
