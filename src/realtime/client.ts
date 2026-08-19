import WebSocket from 'ws';

export interface OpenAIRealtimeEvent {
  type: string;
  [key: string]: unknown;
}

export type EventHandler = (event: OpenAIRealtimeEvent) => void | Promise<void>;

/** 'queued' means the request will be sent when the active response finishes. */
export type ResponseRequestOutcome = 'sent' | 'queued' | 'failed';

export interface OpenAIRealtimeClient {
  on(event: string, handler: EventHandler): void;
  off(event: string, handler: EventHandler): void;
  sendAudio(base64: string): void;
  sendText(text: string): void;
  sendFunctionResult(toolCallId: string, result: unknown): void;
  /** Ask the model to speak, serialized against any response already in flight. */
  requestResponse(response?: Record<string, unknown>): ResponseRequestOutcome;
  send(event: OpenAIRealtimeEvent): boolean;
  close(): void;
}

// The Realtime API allows one active response per conversation. A second
// response.create while one is in flight is rejected with
// conversation_already_has_active_response, so requests are serialized here.
const ACTIVE_RESPONSE_ERROR = 'conversation_already_has_active_response';

const RESPONSE_ENDED_EVENTS = new Set([
  'response.done',
  'response.cancelled',
  'response.incomplete',
  'response.failed',
]);

// If a response never reports completion, assume it ended rather than staying
// silent for the rest of the call. Long enough to outlast a normal spoken turn.
const RESPONSE_STALE_MS = 30_000;

export function createOpenAIRealtimeClient(apiKey: string, model: string): OpenAIRealtimeClient {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const handlers = new Map<string, Set<EventHandler>>();

  let responseActive = false;
  let responseConfirmed = false;
  let responseStartedAt = 0;
  let queuedResponse: Record<string, unknown> | null = null;
  let hasQueuedResponse = false;

  const responseInFlight = () =>
    responseActive && Date.now() - responseStartedAt < RESPONSE_STALE_MS;

  const writeResponseCreate = (response?: Record<string, unknown>): boolean => {
    if (ws.readyState !== WebSocket.OPEN) return false;
    const event: OpenAIRealtimeEvent = { type: 'response.create' };
    if (response) event.response = response;
    ws.send(JSON.stringify(event));
    // Treat the response as active as soon as it is requested. response.created
    // confirms it; without this, two rapid requests would both look idle.
    responseActive = true;
    responseConfirmed = false;
    responseStartedAt = Date.now();
    return true;
  };

  const flushQueuedResponse = () => {
    if (!hasQueuedResponse) return;
    hasQueuedResponse = false;
    const pending = queuedResponse;
    queuedResponse = null;
    writeResponseCreate(pending ?? undefined);
  };

  const trackResponseState = (event: OpenAIRealtimeEvent) => {
    if (event.type === 'response.created') {
      responseActive = true;
      responseConfirmed = true;
      responseStartedAt = Date.now();
      return;
    }
    if (RESPONSE_ENDED_EVENTS.has(event.type)) {
      responseActive = false;
      responseConfirmed = false;
      flushQueuedResponse();
      return;
    }
    if (event.type !== 'error') return;

    const code = (event.error as { code?: string } | undefined)?.code;
    if (code === ACTIVE_RESPONSE_ERROR) {
      // The rejected reply still needs to be spoken, so hold it until the
      // response the server is working on finishes. Dropping it here is what
      // left the caller listening to silence.
      responseActive = true;
      responseStartedAt = Date.now();
      if (!hasQueuedResponse) {
        hasQueuedResponse = true;
        queuedResponse = null;
      }
      return;
    }
    // Some other request was refused. If the server never confirmed our response,
    // it is not running, and holding the flag would mute the rest of the call.
    if (!responseConfirmed) responseActive = false;
  };

  const emit = (event: OpenAIRealtimeEvent) => {
    trackResponseState(event);
    const set = handlers.get(event.type);
    if (set) set.forEach((h) => h(event));
    // Wildcard listeners observe the event stream for diagnostics. Registered
    // separately so a diagnostic listener can never consume a typed handler.
    const wildcard = handlers.get('*');
    if (wildcard) wildcard.forEach((h) => h(event));
  };

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const text = typeof data === 'string' ? data : data.toString();
      const event = JSON.parse(text) as OpenAIRealtimeEvent;
      emit(event);
    } catch {
      // Ignore non-JSON or binary messages.
    }
  });

  ws.on('error', () => {
    // Surface a safe, non-detailed error to the bridge. Never forward raw WebSocket messages.
    // `fatal` marks a dead transport, as opposed to the server refusing one request:
    // only the former justifies ending the caller's call.
    emit({ type: 'error', fatal: true, error: 'OpenAI Realtime connection error' });
  });

  ws.on('close', () => {
    emit({ type: 'close' });
  });

  const requestResponse = (response?: Record<string, unknown>): ResponseRequestOutcome => {
    if (ws.readyState !== WebSocket.OPEN) return 'failed';
    if (responseInFlight()) {
      // One slot is enough: several tool results inside a turn should produce a
      // single spoken reply, not one per result. The earliest request wins so the
      // instructions the model was given first are the ones honored.
      if (!hasQueuedResponse) {
        hasQueuedResponse = true;
        queuedResponse = response ?? null;
      }
      return 'queued';
    }
    return writeResponseCreate(response) ? 'sent' : 'failed';
  };

  return {
    requestResponse,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
    },
    sendAudio(base64) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64 }));
      }
    },
    sendText(text) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text }],
            },
          }),
        );
        requestResponse();
      }
    },
    sendFunctionResult(toolCallId, result) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: toolCallId,
              output: JSON.stringify(result),
            },
          }),
        );
        // The tool output always reaches the conversation; only the spoken reply
        // waits its turn, so nothing the model needs is ever lost.
        requestResponse();
      }
    },
    send(event) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
        return true;
      }
      return false;
    },
    close() {
      ws.close();
    },
  };
}
