import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// createOpenAIRealtimeClient builds its own socket, so the ws module is replaced
// to observe exactly what the client puts on the wire and to feed it server events.
const { MockWs, instances } = vi.hoisted(() => {
  const instances: any[] = [];
  class MockWs {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    sent: any[] = [];
    private listeners = new Map<string, Function[]>();
    constructor(public url: string, public opts?: unknown) {
      instances.push(this);
    }
    on(event: string, cb: Function) {
      const list = this.listeners.get(event) ?? [];
      list.push(cb);
      this.listeners.set(event, list);
      return this;
    }
    send(data: string) {
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.readyState = MockWs.CLOSED;
      this.fire('close');
    }
    fire(event: string, ...args: unknown[]) {
      (this.listeners.get(event) ?? []).forEach((cb) => cb(...args));
    }
    /** Deliver a server event to the client, as the real socket would. */
    receive(obj: unknown) {
      this.fire('message', JSON.stringify(obj));
    }
    typesSent() {
      return this.sent.map((e: any) => e.type);
    }
    countSent(type: string) {
      return this.sent.filter((e: any) => e.type === type).length;
    }
  }
  return { MockWs, instances };
});

vi.mock('ws', () => ({ default: MockWs, WebSocket: MockWs }));

import { createOpenAIRealtimeClient } from '../src/realtime/client';

function newClient() {
  instances.length = 0;
  const client = createOpenAIRealtimeClient('test-key', 'gpt-realtime-2');
  return { client, ws: instances[0] as InstanceType<typeof MockWs> };
}

describe('realtime response serialization', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a response immediately when none is active', () => {
    const { client, ws } = newClient();
    client.sendFunctionResult('tc-1', { ok: true });

    expect(ws.countSent('conversation.item.create')).toBe(1);
    expect(ws.countSent('response.create')).toBe(1);
  });

  // The bug: the escalation tool result arrived while the emergency turn was still
  // speaking, so response.create was rejected with
  // conversation_already_has_active_response and the call was torn down.
  it('does not start a second response while one is active', () => {
    const { client, ws } = newClient();
    ws.receive({ type: 'response.created' });

    client.sendFunctionResult('tc-1', { ok: true });

    // The tool output must still reach the conversation; only speech is deferred.
    expect(ws.countSent('conversation.item.create')).toBe(1);
    expect(ws.countSent('response.create')).toBe(0);
  });

  it('speaks the deferred response once the active one finishes', () => {
    const { client, ws } = newClient();
    ws.receive({ type: 'response.created' });
    client.sendFunctionResult('tc-1', { ok: true });
    expect(ws.countSent('response.create')).toBe(0);

    ws.receive({ type: 'response.done' });

    expect(ws.countSent('response.create')).toBe(1);
  });

  it('coalesces several deferred requests into a single spoken response', () => {
    const { client, ws } = newClient();
    ws.receive({ type: 'response.created' });

    client.sendFunctionResult('tc-1', { ok: true });
    client.sendFunctionResult('tc-2', { ok: true });
    client.sendText('and one more thing');

    ws.receive({ type: 'response.done' });

    expect(ws.countSent('conversation.item.create')).toBe(3);
    expect(ws.countSent('response.create')).toBe(1);
  });

  it('treats a cancelled response as finished so a barge-in does not mute the call', () => {
    const { client, ws } = newClient();
    ws.receive({ type: 'response.created' });
    client.sendFunctionResult('tc-1', { ok: true });

    ws.receive({ type: 'response.cancelled' });

    expect(ws.countSent('response.create')).toBe(1);
  });

  it('recovers when the server reports a response is already active', () => {
    const { client, ws } = newClient();

    // No response.created was observed, so the client believes it is idle and sends.
    client.sendFunctionResult('tc-1', { ok: true });
    expect(ws.countSent('response.create')).toBe(1);

    ws.receive({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'conversation_already_has_active_response' },
    });
    // The reply was rejected, so it must be retried rather than dropped --
    // dropping it is what left the caller in silence.
    ws.receive({ type: 'response.done' });

    expect(ws.countSent('response.create')).toBe(2);
  });

  it('reports whether a request was sent, queued, or failed', () => {
    const { client, ws } = newClient();
    expect(client.requestResponse()).toBe('sent');

    ws.receive({ type: 'response.created' });
    expect(client.requestResponse()).toBe('queued');

    ws.readyState = MockWs.CLOSED;
    expect(client.requestResponse()).toBe('failed');
  });

  // A missed response.done must not mute the receptionist for the rest of the call.
  it('recovers if a response never reports completion', () => {
    vi.useFakeTimers();
    const { client, ws } = newClient();
    ws.receive({ type: 'response.created' });

    expect(client.requestResponse()).toBe('queued');

    vi.advanceTimersByTime(31_000);

    expect(client.requestResponse()).toBe('sent');
  });

  // The bridge decides whether to hang up based on this flag, so the distinction
  // between "socket is gone" and "server refused one request" has to be explicit.
  it('marks transport failures as fatal and API rejections as not', () => {
    const { client, ws } = newClient();
    const seen: any[] = [];
    client.on('error', (e) => seen.push(e));

    ws.fire('error', new Error('socket blew up'));
    expect(seen).toHaveLength(1);
    expect(seen[0].fatal).toBe(true);

    ws.receive({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'conversation_already_has_active_response' },
    });
    expect(seen).toHaveLength(2);
    expect(seen[1].fatal).toBeUndefined();
  });
});
