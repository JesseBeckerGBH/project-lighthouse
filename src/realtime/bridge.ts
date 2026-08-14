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
import { err, ok, Result, generateRequestId } from '../errors';
import { emit } from '../audit';

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

    this.openaiClient.on('error', () => {
      emit({
        event: 'error',
        requestId: this.requestId,
        channel: 'voice',
        sessionId: this.callSid,
        sanitizedSummary: 'OpenAI Realtime connection error',
      });
      this.cleanup();
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

    const sent = this.openaiClient.send({
      type: 'response.create',
      response: { instructions: getGreetingInstruction() },
    });

    if (!sent) {
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
          const parsed = JSON.parse(args) as { summary: string };
          result = await classifyCall(requestId, sessionId, channel, parsed.summary);
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
