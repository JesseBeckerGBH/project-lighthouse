# Project Lighthouse — AI Receptionist Demo

A demo AI receptionist. A caller dials a real Twilio number, talks to an OpenAI Realtime
voice agent, gets configured business facts, can request a **simulated** appointment, or can
trigger a safe emergency escalation. Inbound SMS runs the same rules. The owner gets a
concise notification either way.

```
customer calls or texts -> receptionist understands -> answers or takes a bounded action -> owner gets a summary
```

**This is a demo, not a product.** It does not book real appointments, take payments, dispatch
anyone, or contact emergency services. `lighthouse-spec-v0.1.md` is the pinned source of truth
for scope and behavior — read it before changing anything.

## Safety boundaries (deliberate, and tested)

The agent will not:

- create an appointment before the caller explicitly confirms a read-back of the details
- claim a technician is assigned, en route, or arriving at a time
- claim 911, emergency services, or the owner has responded
- quote a price, approve a refund, diagnose a dangerous condition, or promise coverage
- collect card or bank details
- invent a business fact it wasn't configured with (it returns `FACT_NOT_CONFIGURED`)

Writes are idempotent: the same session + tool call replays the original result, and a changed
payload on the same key returns `CONFLICT` instead of writing twice. A failed owner
notification never erases a saved record — it surfaces a retryable error.

## Requirements

- Node.js 20+
- A Twilio account with a voice + SMS capable number
- An OpenAI API key with Realtime access
- A public HTTPS tunnel for local demos (`ngrok`, `cloudflared`)

## Quickstart (local, no phone calls)

```bash
npm install
cp .env.example .env      # fill in real values; .env is gitignored, never commit it
npm test                  # 85 tests, no paid services touched
npm run dev               # tsx watch on http://localhost:3000
curl http://localhost:3000/health
```

`NOTIFICATION_MODE=console` is the default, so owner notifications print to stdout and no SMS
is sent. That's the safe way to develop.

## Live demo setup

1. **Tunnel.** `ngrok http 3000` (or `cloudflared tunnel --url http://localhost:3000`).
2. **Set `PUBLIC_BASE_URL` to the exact tunnel origin**, e.g. `https://abc123.ngrok.app` — no
   trailing slash. Twilio signature validation hashes the full URL; a mismatch here is the #1
   cause of a `403 Invalid Twilio signature` that looks like a Twilio problem but isn't.
3. **Restart the server** so it picks up the new `PUBLIC_BASE_URL`.
4. **Point the Twilio number** at the tunnel:
   - Voice: `POST https://<tunnel>/twilio/voice`
   - Messaging: `POST https://<tunnel>/twilio/sms`
5. **Call the number.** The receptionist greets you first — you should hear it before you speak.
6. Optional: set `NOTIFICATION_MODE=twilio` and `OWNER_PHONE_NUMBER` to get owner
   notifications as real SMS.

Local tests passing proves nothing about Twilio, OpenAI, the tunnel, or audio quality. Those
are manual checks, every time.

## Configuration

Copy `.env.example` to `.env`. All variables are required unless noted; startup fails with a
list of what's missing and never prints values.

| Variable | Notes |
|---|---|
| `NODE_ENV` | `development`, `test`, or `production`. `/demo/reset` only exists in the first two. |
| `PORT` | Default `3000`. |
| `PUBLIC_BASE_URL` | Exact public origin. Used for TwiML stream URL and signature validation. |
| `OPENAI_API_KEY` | Needs Realtime access. |
| `OPENAI_REALTIME_MODEL` | Must be a currently-available Realtime model id. See troubleshooting. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Auth token also enables webhook signature validation. |
| `TWILIO_PHONE_NUMBER` | The demo number. |
| `OWNER_PHONE_NUMBER` | Required only when `NOTIFICATION_MODE=twilio`. |
| `BUSINESS_NAME`, `BUSINESS_HOURS`, `BUSINESS_SERVICE_AREA`, `BUSINESS_SERVICES`, `BUSINESS_TIMEZONE` | The only facts the agent may state. |
| `SCHEDULER_MODE` | `fake`. There is no real mode. |
| `NOTIFICATION_MODE` | `console` (default) or `twilio`. |
| `LOG_LEVEL` | `info`, `silent`, etc. |

## Endpoints

| Route | Purpose |
|---|---|
| `GET /health` | Readiness. No secrets. |
| `POST /twilio/voice` | Returns TwiML connecting the call to the media stream, passing the caller number as a `<Parameter>`. |
| `WS /twilio/media` | Bridges 8 kHz G.711 mu-law audio to and from OpenAI Realtime. Handles barge-in. |
| `POST /twilio/sms` | Same classification and bounded workflows as voice; replies with one message. |
| `POST /demo/reset` | Clears demo records. Returns 404 unless `NODE_ENV` is `development` or `test`. |

## Demo script

1. Ask a configured question ("what are your hours?", "what's your service area?").
2. Ask for service and request an appointment.
3. Let it read the request back, then confirm explicitly.
4. Show the fake appointment ID and the owner notification.
5. Text the number a question; get a bounded reply.
6. Use a controlled emergency phrase; show the safety language, the escalation record, and the
   owner notification — and point out it never claims anyone was dispatched.
7. Say plainly that scheduling is simulated and payments are intentionally out of scope.

## Architecture

Thin platform adapters, decisions in the domain layer — never in prompts or webhook handlers.

```
src/
  server.ts              startup, routes, WebSocket upgrade
  config.ts              validated env + configured business facts
  routes/                twilioVoice, twilioSms, health, demoReset
  realtime/bridge.ts     Twilio <-> OpenAI Realtime event bridge, greeting, barge-in, cleanup
  realtime/client.ts     OpenAI Realtime WebSocket adapter
  agent/instructions.ts  system prompt + greeting, generated from config
  agent/tools.ts         the four bounded tool definitions
  domain/                classifier, faq, fakeScheduler, escalation, idempotency, service
  notifications/         console/Twilio owner notifier behind one interface
  storage/store.ts       in-memory demo store behind a small interface
  audit.ts               structured events, secrets and transcripts stripped
```

Storage is in-memory and resets on restart. That is fine for a demo and not fine for anything else.

## Tests

```bash
npm test          # vitest run
npm run test:watch
```

85 tests, all offline with fake credentials and mocked providers. They cover signature accept/
reject, TwiML stream URL, media parsing and barge-in, all four classifications, unknown facts,
confirmation gating, idempotent replay and conflict, emergency escalation without dispatch
claims, notification-failure preservation, SMS duplicate delivery, production hiding
`/demo/reset`, and secrets never reaching logs or responses.

## Troubleshooting

**Silence when the call connects.** The agent greets first once both the OpenAI session is
configured and the Twilio stream has started. If you hear nothing, check the server log for
`Initial greeting failed to send` and confirm the OpenAI WebSocket actually opened.

**403 Invalid Twilio signature.** `PUBLIC_BASE_URL` doesn't exactly match the URL Twilio
requested. Check scheme, host, port, and trailing slash. Restart after changing it.

**The call connects but the agent never responds.** Usually a bad `OPENAI_REALTIME_MODEL`. A
dead or misspelled Realtime model id closes the WebSocket with a generic error that reads like
an authentication failure — verify the model id against OpenAI's current Realtime model list
before assuming your key is wrong.

**Caller hears the agent but the agent hears nothing.** Audio format mismatch. Both directions
must be `audio/pcmu` (G.711 mu-law, 8 kHz) to match Twilio Media Streams.

**Inbound SMS never gets a reply.** In the US, replying from a long code requires A2P 10DLC
registration; toll-free verification is the faster path. Start it well before demo day — it is
calendar time you don't control.

**`Missing required environment variables: ...`** Exactly what it says. Values are never printed.

## Out of scope until after demo day

Real calendars, real bookings, payments, autonomous dispatch, technician assignment or ETAs,
pricing or diagnosis, outbound campaigns, customer accounts, dashboards, analytics,
multi-tenancy, production infrastructure, and long-term transcript storage.

Adding any of these requires a deliberate spec change first — see section 15 of
`lighthouse-spec-v0.1.md`.
