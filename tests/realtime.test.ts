import { describe, it, expect, vi } from 'vitest';
import WebSocket from 'ws';
import { RealtimeBridge } from '../src/realtime/bridge';
import type { OpenAIRealtimeClient } from '../src/realtime/client';

type Handler = (event: any) => void | Promise<void>;
type MockClient = OpenAIRealtimeClient & {
  emit: (event: any) => Promise<void>;
  getSent: () => any[];
};

function createMockClient(): MockClient {
  const handlers = new Map<string, Set<Handler>>();
  const sent: any[] = [];
  const client = {
    on(event: string, handler: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
    },
    async emit(event: any) {
      const set = handlers.get(event.type);
      if (set) {
        for (const h of set) {
          await h(event);
        }
      }
    },
    sendAudio(base64: string) {
      sent.push({ type: 'input_audio_buffer.append', audio: base64 });
    },
    sendText(text: string) {
      sent.push({ type: 'input_text', text });
    },
    sendFunctionResult(toolCallId: string, result: unknown) {
      sent.push({ type: 'function_call_output', toolCallId, result });
    },
    send(event: any) {
      sent.push(event);
      return true;
    },
    close() {
      sent.push({ type: 'close' });
    },
    getSent() {
      return sent;
    },
  };
  return client as unknown as MockClient;
}

function createMockTwilioWebSocket() {
  const sent: any[] = [];
  return {
    readyState: 1, // WebSocket.OPEN
    sent,
    send: vi.fn((msg: string) => {
      try {
        sent.push(JSON.parse(msg));
      } catch {
        sent.push(msg);
      }
    }),
    on: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
}

describe('realtime bridge', () => {
  it('creates one isolated session per Twilio stream', () => {
    const twilio1 = createMockTwilioWebSocket();
    const twilio2 = createMockTwilioWebSocket();
    const client1 = createMockClient();
    const client2 = createMockClient();

    const bridge1 = new RealtimeBridge(twilio1, client1);
    const bridge2 = new RealtimeBridge(twilio2, client2);

    bridge1.handleTwilioMessage({
      event: 'start',
      start: { streamSid: 'stream-1', callSid: 'call-1', from: '+1111' },
    });
    bridge2.handleTwilioMessage({
      event: 'start',
      start: { streamSid: 'stream-2', callSid: 'call-2', from: '+2222' },
    });
    client1.emit({ type: 'session.created' });
    client2.emit({ type: 'session.created' });

    bridge1.handleTwilioMessage({ event: 'media', media: { payload: 'audio-a' } });
    bridge2.handleTwilioMessage({ event: 'media', media: { payload: 'audio-b' } });

    const sent1 = client1.getSent().filter((e) => e.type === 'input_audio_buffer.append');
    const sent2 = client2.getSent().filter((e) => e.type === 'input_audio_buffer.append');

    expect(sent1).toHaveLength(1);
    expect(sent2).toHaveLength(1);
    expect(sent1[0].audio).toBe('audio-a');
    expect(sent2[0].audio).toBe('audio-b');
  });

  it('sends the current GA session.update shape after session.created', async () => {
    const twilio = createMockTwilioWebSocket();
    const client = createMockClient();
    const bridge = new RealtimeBridge(twilio, client);

    bridge.handleTwilioMessage({
      event: 'start',
      start: { streamSid: 'stream-1', callSid: 'call-1', from: '+1111' },
    });
    expect(client.getSent().filter((e) => e.type === 'session.update')).toHaveLength(0);

    await client.emit({ type: 'session.created' });

    const sessionUpdates = client.getSent().filter((e) => e.type === 'session.update');
    expect(sessionUpdates).toHaveLength(1);
    const session = sessionUpdates[0].session;
    expect(session.type).toBe('realtime');
    expect(session.output_modalities).toEqual(['audio']);
    expect(session.audio).toBeDefined();
    expect(session.audio.input.format).toEqual({ type: 'audio/pcmu' });
    expect(session.audio.output.format).toEqual({ type: 'audio/pcmu' });
    expect(session.audio.input.turn_detection).toEqual({ type: 'server_vad' });
    expect(session.audio.output.voice).toBe('alloy');
    const tools = session.tools;
    expect(tools).toHaveLength(4);
    const names = tools.map((t: any) => t.name);
    expect(names).toEqual(['classify_call', 'answer_business_question', 'schedule_appointment', 'escalate_emergency']);
    expect(session.model).toBeUndefined();
    expect(session.modalities).toBeUndefined();
    expect(session.voice).toBeUndefined();
    expect(session.turn_detection).toBeUndefined();
    expect(session.input_audio_format).toBeUndefined();
    expect(session.output_audio_format).toBeUndefined();
  });

  it('does not send session.update before session.created', () => {
    const twilio = createMockTwilioWebSocket();
    const client = createMockClient();
    const bridge = new RealtimeBridge(twilio, client);

    bridge.handleTwilioMessage({
      event: 'start',
      start: { streamSid: 'stream-1', callSid: 'call-1', from: '+1111' },
    });
    bridge.handleTwilioMessage({ event: 'media', media: { payload: 'ulaw-audio' } });

    expect(client.getSent().filter((e) => e.type === 'session.update')).toHaveLength(0);
    expect(client.getSent().filter((e) => e.type === 'input_audio_buffer.append')).toHaveLength(0);
  });

  it('buffers Twilio audio before session.created and flushes in order after session.update', async () => {
    const twilio = createMockTwilioWebSocket();
    const client = createMockClient();
    const bridge = new RealtimeBridge(twilio, client);

    bridge.handleTwilioMessage({
      event: 'start',
      start: { streamSid: 'stream-1', callSid: 'call-1', from: '+1111' },
    });
    bridge.handleTwilioMessage({ event: 'media', media: { payload: 'chunk-1' } });
    bridge.handleTwilioMessage({ event: 'media', media: { payload: 'chunk-2' } });
    bridge.handleTwilioMessage({ event: 'media', media: { payload: 'chunk-3' } });

    await client.emit({ type: 'session.created' });

    const sessionUpdates = client.getSent().filter((e) => e.type === 'session.update');
    expect(sessionUpdates).toHaveLength(1);

    const audio = client.getSent().filter((e) => e.type === 'input_audio_buffer.append');
    expect(audio).toHaveLength(3);
    expect(audio[0].audio).toBe('chunk-1');
    expect(audio[1].audio).toBe('chunk-2');
    expect(audio[2].audio).toBe('chunk-3');
  });

  it('enforces a safe maximum on the pre-connection audio buffer', async () => {
    const twilio = createMockTwilioWebSocket();
    const client = createMockClient();
    const bridge = new RealtimeBridge(twilio, client);

    bridge.handleTwilioMessage({
      event: 'start',
      start: { streamSid: 'stream-1', callSid: 'call-1', from: '+1111' },
    });
    for (let i = 1; i <= 25; i += 1) {
      bridge.handleTwilioMessage({ event: 'media', media: { payload: `chunk-${i}` } });
    }

    await client.emit({ type: 'session.created' });

    const audio = client.getSent().filter((e) => e.type === 'input_audio_buffer.append');
    expect(audio.length).toBeLessThanOrEqual(20);
    expect(audio[0].audio).toBe('chunk-6');
    expect(audio[audio.length - 1].audio).toBe('chunk-25');
  });

  it('forwards response.output_audio.delta to Twilio with media and mark events', async () => {
    const twilio = createMockTwilioWebSocket();
    const client = createMockClient();
    const bridge = new RealtimeBridge(twilio, client);

    bridge.handleTwilioMessage({
      event: 'start',
      start: { streamSid: 'stream-1', callSid: 'call-1', from: '+1111' },
    });
    await client.emit({ type: 'session.created' });
    await client.emit({ type: 'response.output_audio.delta', delta: 'out-audio' });

    const mediaEvents = twilio.sent.filter((e: any) => e.event === 'media');
    const markEvents = twilio.sent.filter((e: any) => e.event === 'mark');
    expect(mediaEvents).toHaveLength(1);
    expect(mediaEvents[0].media.payload).toBe('out-audio');
    expect(markEvents).toHaveLength(1);
  });

  it('clears queued Twilio audio on caller interruption', async () => {
    const twilio = createMockTwilioWebSocket();
    const client = createMockClient();
    const bridge = new RealtimeBridge(twilio, client);

    bridge.handleTwilioMessage({
      event: 'start',
      start: { streamSid: 'stream-1', callSid: 'call-1', from: '+1111' },
    });
    await client.emit({ type: 'session.created' });
    await client.emit({ type: 'response.output_audio.delta', delta: 'chunk-1' });
    await client.emit({ type: 'input_audio_buffer.speech_started' });

    const clearEvents = twilio.sent.filter((e: any) => e.event === 'clear');
    expect(clearEvents).toHaveLength(1);
    expect(clearEvents[0].streamSid).toBe('stream-1');
  });

  it('greets the caller once the session is ready and the stream has started', async () => {
    const twilio = createMockTwilioWebSocket();
    const client = createMockClient();
    const bridge = new RealtimeBridge(twilio, client);

    bridge.handleTwilioMessage({
      event: 'start',
      start: { streamSid: 'stream-1', callSid: 'call-1' },
    });
    await client.emit({ type: 'session.created' });

    const greetings = client.getSent().filter((e) => e.type === 'response.create');
    expect(greetings).toHaveLength(1);
  });

  it('does not greet before the Twilio stream has started', async () => {
    const twilio = createMockTwilioWebSocket();
    const client = createMockClient();
    const bridge = new RealtimeBridge(twilio, client);

    await client.emit({ type: 'session.created' });
    expect(client.getSent().filter((e) => e.type === 'response.create')).toHaveLength(0);

    bridge.handleTwilioMessage({
      event: 'start',
      start: { streamSid: 'stream-1', callSid: 'call-1' },
    });
    expect(client.getSent().filter((e) => e.type === 'response.create')).toHaveLength(1);
  });

  it('reads the caller number from Twilio stream custom parameters', async () => {
    const twilio = createMockTwilioWebSocket();
    const client = createMockClient();
    const bridge = new RealtimeBridge(twilio, client);

    bridge.handleTwilioMessage({
      event: 'start',
      start: { streamSid: 'stream-1', callSid: 'call-1', customParameters: { from: '+15551239999' } },
    });
    await client.emit({ type: 'session.created' });
    await client.emit({
      type: 'response.function_call_arguments.done',
      name: 'escalate_emergency',
      arguments: JSON.stringify({ situation_summary: 'Gas smell in the kitchen', confirmed: true }),
      call_id: 'tc-caller-id',
    });

    const results = client.getSent().filter((e: any) => e.type === 'function_call_output');
    expect(results).toHaveLength(1);
    expect(results[0].result.data?.escalation?.callbackNumber).toBe('+15551239999');
  });

  it('dispatches classify_call tool and returns a result', async () => {
    const twilio = createMockTwilioWebSocket();
    const client = createMockClient();
    const bridge = new RealtimeBridge(twilio, client);

    bridge.handleTwilioMessage({
      event: 'start',
      start: { streamSid: 'stream-1', callSid: 'call-1', from: '+1111' },
    });
    await client.emit({ type: 'session.created' });
    await client.emit({
      type: 'response.function_call_arguments.done',
      name: 'classify_call',
      arguments: JSON.stringify({ summary: 'I need an appointment' }),
      call_id: 'tc-1',
    });

    const results = client.getSent().filter((e: any) => e.type === 'function_call_output');
    expect(results).toHaveLength(1);
    expect(results[0].toolCallId).toBe('tc-1');
    expect(results[0].result.ok).toBe(true);
    expect(results[0].result.data?.intent).toBe('NEW_LEAD');
  });

  it('dispatches escalate_emergency tool and records the escalation', async () => {
    const twilio = createMockTwilioWebSocket();
    const client = createMockClient();
    const bridge = new RealtimeBridge(twilio, client);

    bridge.handleTwilioMessage({
      event: 'start',
      start: { streamSid: 'stream-1', callSid: 'call-1', from: '+1111' },
    });
    await client.emit({ type: 'session.created' });
    await client.emit({
      type: 'response.function_call_arguments.done',
      name: 'escalate_emergency',
      arguments: JSON.stringify({
        callback_number: '+1111',
        situation_summary: 'Fire in the kitchen',
        confirmed: false,
      }),
      call_id: 'tc-2',
    });

    const results = client.getSent().filter((e: any) => e.type === 'function_call_output');
    expect(results).toHaveLength(1);
    expect(results[0].toolCallId).toBe('tc-2');
    expect(results[0].result.data?.escalation).toBeDefined();
  });

  it('cleans up both sides when OpenAI closes before readiness', async () => {
    const twilio = createMockTwilioWebSocket();
    const client = createMockClient();
    const bridge = new RealtimeBridge(twilio, client);

    bridge.handleTwilioMessage({
      event: 'start',
      start: { streamSid: 'stream-1', callSid: 'call-1', from: '+1111' },
    });
    await client.emit({ type: 'close' });

    expect(twilio.close).toHaveBeenCalledTimes(1);
    expect(client.getSent().filter((e: any) => e.type === 'close')).toHaveLength(1);
  });

  it('cleans up provider connections on stop and is idempotent', () => {
    const twilio = createMockTwilioWebSocket();
    const client = createMockClient();
    const bridge = new RealtimeBridge(twilio, client);

    bridge.handleTwilioMessage({
      event: 'start',
      start: { streamSid: 'stream-1', callSid: 'call-1', from: '+1111' },
    });
    bridge.handleTwilioMessage({ event: 'stop' });
    bridge.handleTwilioMessage({ event: 'stop' });

    expect(twilio.close).toHaveBeenCalledTimes(1);
    expect(client.getSent().filter((e: any) => e.type === 'close')).toHaveLength(1);
  });
});
