import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import { createServer } from 'http';
import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { getConfig } from './config';
import { generateRequestId } from './errors';
import { healthRouter } from './routes/health';
import { twilioVoiceRouter } from './routes/twilioVoice';
import { twilioSmsRouter } from './routes/twilioSms';
import { demoResetRouter } from './routes/demoReset';
import { RealtimeBridge } from './realtime/bridge';
import { createOpenAIRealtimeClient } from './realtime/client';
import { emit } from './audit';

export const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use('/health', healthRouter);
app.use('/twilio/voice', twilioVoiceRouter);
app.use('/twilio/sms', twilioSmsRouter);
app.use('/demo/reset', demoResetRouter);

app.use((_req, res) => {
  res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'Not found.' });
});

function startServer() {
  const config = getConfig();
  const server = createServer(app);
  const wss = new WebSocketServer({ path: '/twilio/media', server });

  wss.on('connection', (twilioWs: WebSocket) => {
    const requestId = generateRequestId();
    const callSid = `call-${requestId}`;
    const openaiClient = createOpenAIRealtimeClient(config.openaiApiKey, config.openaiRealtimeModel);
    const bridge = new RealtimeBridge(twilioWs, openaiClient);
    emit({ event: 'voice_in', requestId, channel: 'voice', sessionId: callSid });

    twilioWs.on('message', (data: WebSocket.Data) => {
      try {
        const text = typeof data === 'string' ? data : data.toString();
        const message = JSON.parse(text);
        bridge.handleTwilioMessage(message);
      } catch {
        // Ignore malformed messages.
      }
    });

    twilioWs.on('close', () => bridge.cleanup());
    twilioWs.on('error', () => {});
  });

  server.listen(config.port, () => {
    console.log(`Lighthouse demo listening on port ${config.port}`);
  });

  return server;
}

if (process.env.NODE_ENV !== 'test') {
  startServer();
}
