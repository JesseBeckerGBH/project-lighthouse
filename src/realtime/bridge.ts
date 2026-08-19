import WebSocket from 'ws';
import { getSystemPrompt, getGreetingInstruction } from '../agent/instructions';
import { tools } from '../agent/tools';
import { OpenAIRealtimeClient, OpenAIRealtimeEvent } from './client';
import {
  classifyCall,
  answerBusinessFact,
  scheduleAppointment,
  escalateEmergency,
  AppointmentInput,
  EscalationInputFull,
} from '../domain/service';
import { isIntent } from '../domain/classifier';
import { getConfig } from '../config';
import { err, ok, Result, generateRequestId } from '../errors';
import { emit } from '../audit';

// Turn-lifecycle events, always recorded. Enough to tell "model stuck mid-turn"
// from "never heard the caller" without logging conversation content.
const LIFECYCLE_EVENTS = new Set([
  'session.updated',
  'response.created',
  'response.done',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.committed',
  'error',
  'close',
]);

interface StartPayload {
  streamSid: string;
  callSid: string;
  // Twilio's start event carries no `from` field; the caller number arrives as a
  // <Parameter> declared on <Stream> in the voice TwiML.
  customParameters?: Record<string, string>;
}

export class RealtimeBridge {
  private twilioWs: WebSocket;
  private openaiClient: OpenAIRealtimeClient;
  private requestId: string;
  private callSid: string = 'unknown';
  private streamSid: string | null = null;
  private callerNumber: string = 'unknown';
  private queuedAudio: string[] = [];
  private audioMarks: string[] = [];
  private pendingAudio: string[] = [];
  private readonly maxPendingAudio = 20;
  private started = false;
  private sessionUpdated = false;
  private greeted = false;
  private cleanedUp = false;

  constructor(twilioWs: WebSocket, openaiClient: OpenAIRealtimeClient) {
    this.twilioWs = twilioWs;
    this.openaiClient = openaiClient;
    this.requestId = generateRequestId();
    this.setupOpenAI();
  }

  private setupOpenAI() {
    this.openaiClient.on('session.created', () => {
      this.sendSessionUpdate();
    });

    this.openaiClient.on('response.output_audio.delta', (event) => {
      const payload = event.delta as string;
      if (payload) {
        this.queuedAudio.push(payload);
        this.sendTwilioMedia(payload);
      }
    });

    this.openaiClient.on('input_audio_buffer.speech_started', () => {
      this.clearTwilioAudio();
    });

    this.openaiClient.on('response.function_call_arguments.done', async (event) => {
      const name = (event.name as string) ?? '';
      const args = (event.arguments as string) ?? '{}';
      const callId = (event.call_id as string) ?? generateRequestId();
      try {
        await this.handleToolCall(name, args, callId);
      } catch {
        // Tool call failures are returned as function results.
      }
    });

    // A call that goes silent leaves no trace in the business audit log, so record
    // the Realtime turn lifecycle: whether a response was created, whether it
    // completed, and whether speech was detected. Types and error codes only --
    // never transcripts or audio. ~12 lines per call at this level.
    //
    // Kept after diagnosing the 2026-08-16 stall, which reproduced once in four
    // calls and has no confirmed root cause. Without this, a recurrence in front
    // of a customer would be as unexplainable as the first one was.
    this.openaiClient.on('*', (event) => {
      const type = event.type ?? 'unknown';
      if (!LIFECYCLE_EVENTS.has(type) && getConfig().logLevel !== 'debug') return;
      const errorObj = event.error as { code?: string; type?: string } | undefined;
      const code = errorObj?.code ?? errorObj?.type;
      emit({
        event: 'diagnostic',
        requestId: this.requestId,
        channel: 'voice',
        sessionId: this.callSid,
        sanitizedSummary: code ? `${type} (${code})` : type,
      });
    });

    // Only a dead transport ends the call. A rejected request -- a malformed tool
    // argument, a duplicate response.create -- is recoverable, and hanging up on it
    // strands the caller in silence mid-conversation. Both live emergency calls on
    // 2026-08-17 died this way, on conversation_already_has_active_response.
    this.openaiClient.on('error', (event) => {
      const fatal = event.fatal === true;
      const detail = (event.error as { code?: string; type?: string } | undefined)?.code;
      emit({
        event: 'error',
        requestId: this.requestId,
        channel: 'voice',
        sessionId: this.callSid,
        sanitizedSummary: fatal
          ? 'OpenAI Realtime connection error'
          : `OpenAI Realtime request rejected (${detail ?? 'unknown'})`,
      });
      if (fatal) this.cleanup();
    });

    this.openaiClient.on('close', () => {
      this.cleanup();
    });
  }

  handleTwilioMessage(message: OpenAIRealtimeEvent) {
    switch (message.event) {
      case 'connected':
        break;
      case 'start': {
        const start = (message.start as StartPayload) ?? {};
        this.streamSid = start.streamSid ?? this.streamSid;
        this.callSid = start.callSid ?? this.callSid;
        this.callerNumber = start.customParameters?.from ?? this.callerNumber;
        this.started = true;
        emit({
          event: 'voice_in',
          requestId: this.requestId,
          channel: 'voice',
          sessionId: this.callSid,
          sanitizedSummary: 'Call started',
        });
        this.maybeGreet();
        break;
      }
      case 'media': {
        const payload = (message.media as { payload: string })?.payload;
        if (payload) {
          if (this.sessionUpdated) {
            this.openaiClient.sendAudio(payload);
          } else {
            this.pendingAudio.push(payload);
            if (this.pendingAudio.length > this.maxPendingAudio) {
              this.pendingAudio.shift();
            }
          }
        }
        break;
      }
      case 'mark': {
        const name = (message.mark as { name: string })?.name;
        if (name) this.audioMarks.push(name);
        break;
      }
      case 'stop':
        this.cleanup();
        break;
      default:
        break;
    }
  }

  private sendTwilioMedia(payload: string) {
    if (this.twilioWs.readyState === WebSocket.OPEN && this.streamSid) {
      this.twilioWs.send(
        JSON.stringify({
          event: 'media',
          streamSid: this.streamSid,
          media: { payload },
        }),
      );
      const markName = `mark-${Date.now()}`;
      this.audioMarks.push(markName);
      this.twilioWs.send(
        JSON.stringify({
          event: 'mark',
          streamSid: this.streamSid,
          mark: { name: markName },
        }),
      );
    }
  }

  private clearTwilioAudio() {
    this.queuedAudio = [];
    this.audioMarks = [];
    if (this.twilioWs.readyState === WebSocket.OPEN && this.streamSid) {
      this.twilioWs.send(
        JSON.stringify({
          event: 'clear',
          streamSid: this.streamSid,
        }),
      );
    }
  }

  private sendSessionUpdate() {
    if (this.sessionUpdated) return;
    const sent = this.openaiClient.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions: getSystemPrompt(),
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            turn_detection: { type: 'server_vad' },
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: 'alloy',
          },
        },
        tools: tools.map((t) => ({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        tool_choice: 'auto',
      },
    });

    if (!sent) {
      emit({
        event: 'error',
        requestId: this.requestId,
        channel: 'voice',
        sessionId: this.callSid,
        sanitizedSummary: 'OpenAI session update failed to send',
      });
      return;
    }

    this.sessionUpdated = true;
    this.flushPendingAudio();
    this.maybeGreet();
  }

  // The caller must hear the receptionist first. Both sides have to be ready: the OpenAI
  // session must be configured, and the Twilio stream must have started or the greeting
  // audio has no streamSid to be delivered on.
  private maybeGreet() {
    if (this.greeted || this.cleanedUp) return;
    if (!this.sessionUpdated || !this.started) return;

    const outcome = this.openaiClient.requestResponse({ instructions: getGreetingInstruction() });

    if (outcome === 'failed') {
      emit({
        event: 'error',
        requestId: this.requestId,
        channel: 'voice',
        sessionId: this.callSid,
        sanitizedSummary: 'Initial greeting failed to send',
      });
      return;
    }

    this.greeted = true;
  }

  private knownCallerNumber(): string | undefined {
    return this.callerNumber === 'unknown' ? undefined : this.callerNumber;
  }

  private flushPendingAudio() {
    while (this.pendingAudio.length > 0) {
      const payload = this.pendingAudio.shift();
      if (payload) this.openaiClient.sendAudio(payload);
    }
  }

  private async handleToolCall(name: string, args: string, toolCallId: string) {
    const requestId = this.requestId;
    const sessionId = this.callSid;
    const channel = 'voice' as const;
    let result: Result<unknown>;

    try {
      switch (name) {
        case 'classify_call': {
          const parsed = JSON.parse(args) as { summary: string; intent?: string };
          // Model output is untrusted: accept the intent only if it is one of the
          // declared values, otherwise fall back to summary-based classification.
          const reportedIntent = isIntent(parsed.intent) ? parsed.intent : undefined;
          result = await classifyCall(requestId, sessionId, channel, parsed.summary, reportedIntent);
          break;
        }
        case 'answer_business_question': {
          const parsed = JSON.parse(args) as { question: string };
          result = answerBusinessFact(requestId, sessionId, channel, parsed.question);
          break;
        }
        case 'schedule_appointment': {
          const parsed = JSON.parse(args) as Record<string, any>;
          const requestedSlot = parsed.requested_slot ?? parsed.requestedSlot ?? {};
          const input: AppointmentInput = {
            channel,
            sessionId,
            toolCallId,
            callerName: parsed.caller_name ?? parsed.callerName,
            callbackNumber: parsed.callback_number ?? parsed.callbackNumber ?? this.knownCallerNumber(),
            serviceSummary: parsed.service_summary ?? parsed.serviceSummary,
            requestedSlot: {
              date: requestedSlot.date,
              timeWindow: requestedSlot.time_window ?? requestedSlot.timeWindow,
            },
            confirmed: parsed.confirmed,
          };
          result = await scheduleAppointment(input, requestId);
          break;
        }
        case 'escalate_emergency': {
          const parsed = JSON.parse(args) as Record<string, any>;
          const input: EscalationInputFull = {
            channel,
            sessionId,
            toolCallId,
            // Never delay an emergency to collect a number Twilio already gave us.
            callbackNumber: parsed.callback_number ?? parsed.callbackNumber ?? this.knownCallerNumber(),
            situationSummary: parsed.situation_summary ?? parsed.situationSummary,
            location: parsed.location,
            confirmed: parsed.confirmed,
          };
          result = await escalateEmergency(input, requestId);
          break;
        }
        default: {
          result = err('INTERNAL_ERROR', 'Unknown tool called.');
        }
      }
    } catch {
      result = err('INTERNAL_ERROR', 'Failed to process tool call.');
    }

    this.openaiClient.sendFunctionResult(toolCallId, result);
  }

  cleanup() {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.openaiClient.close();
    this.twilioWs.close();
    this.started = false;
    this.sessionUpdated = false;
    this.pendingAudio = [];
    emit({
      event: 'call_end',
      requestId: this.requestId,
      channel: 'voice',
      sessionId: this.callSid,
    });
  }
}
