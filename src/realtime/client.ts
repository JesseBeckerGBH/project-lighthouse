import WebSocket from 'ws';

export interface OpenAIRealtimeEvent {
  type: string;
  [key: string]: unknown;
}

export type EventHandler = (event: OpenAIRealtimeEvent) => void | Promise<void>;

export interface OpenAIRealtimeClient {
  on(event: string, handler: EventHandler): void;
  off(event: string, handler: EventHandler): void;
  sendAudio(base64: string): void;
  sendText(text: string): void;
  sendFunctionResult(toolCallId: string, result: unknown): void;
  send(event: OpenAIRealtimeEvent): boolean;
  close(): void;
}

export function createOpenAIRealtimeClient(apiKey: string, model: string): OpenAIRealtimeClient {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const handlers = new Map<string, Set<EventHandler>>();

  const emit = (event: OpenAIRealtimeEvent) => {
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
    emit({ type: 'error', error: 'OpenAI Realtime connection error' });
  });

  ws.on('close', () => {
    emit({ type: 'close' });
  });

  return {
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
        ws.send(JSON.stringify({ type: 'response.create' }));
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
        ws.send(JSON.stringify({ type: 'response.create' }));
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
