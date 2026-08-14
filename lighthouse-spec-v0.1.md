# Project Lighthouse Demo Specification v0.1

Status: **PINNED SOURCE OF TRUTH**  
Stack: **Node.js + TypeScript + Express**  
Scope: **Demo only; feature-frozen until demo day**

Cascade and contributors MUST read this file before changing architecture, prompts, tool contracts, or workflow behavior. If code and this document disagree, this document wins until the document is deliberately revised. New features require an explicit spec change before implementation.

## 1. Goal

Build a believable AI receptionist demo that lets a caller contact a real Twilio number, speak with an OpenAI Realtime voice agent, receive basic configured business information, request a fake appointment, or trigger a safe emergency escalation. Inbound SMS uses the same bounded business rules and owner-notification path.

The demo proves this journey:

> customer calls or texts -> receptionist understands the request -> receptionist answers or takes a bounded action -> owner receives a concise summary

This is not a production dispatch, scheduling, billing, or emergency-response system.

## 2. Demo success criteria

The demo is successful when all of the following work:

1. A caller reaches the Twilio number and hears the receptionist.
2. Twilio Media Streams and OpenAI Realtime carry a two-way voice conversation.
3. The agent classifies the interaction as `EMERGENCY`, `NEW_LEAD`, `EXISTING_CUSTOMER`, or `GENERAL_QUESTION`.
4. The agent answers only configured business facts and clearly admits when a fact is unavailable.
5. The agent can propose and, after explicit caller confirmation, create a fake appointment record.
6. Emergency language triggers a human-escalation record and owner notification without claiming that emergency services or a technician were dispatched.
7. Inbound SMS can answer configured questions, capture a lead, request a fake appointment, or escalate an emergency using the same safety boundaries.
8. The owner receives a concise demo notification containing channel, caller, classification, summary, and requested next action.
9. Automated tests prove the confirmation, safety, validation, and idempotency boundaries without calling paid services.

## 3. Fixed scope

### Included

- Express server written in TypeScript.
- Twilio inbound Voice webhook and bidirectional Media Streams WebSocket.
- Twilio inbound SMS webhook.
- OpenAI Realtime voice conversation.
- Four intent categories: `EMERGENCY`, `NEW_LEAD`, `EXISTING_CUSTOMER`, and `GENERAL_QUESTION`.
- Configured business FAQs.
- Fake availability and fake appointment creation.
- Explicit confirmation before any appointment write.
- Emergency escalation record and owner notification.
- Owner notification through a replaceable adapter; console output is the safe local default and Twilio SMS may be enabled for the live demo.
- Structured audit events with secrets and sensitive transcript content excluded.
- Health endpoint and deterministic demo reset support in development/test only.

### Excluded until after demo day

- Real calendar integrations or real appointment commitments.
- Real payments, card collection, hosted checkout, refunds, invoices, or deposits.
- Autonomous emergency dispatch or calls to emergency services.
- Technician assignment, live availability, or ETA claims.
- Autonomous pricing, quoting, diagnosis, or warranty decisions.
- Outbound marketing campaigns, bulk SMS, and A2P production work.
- Customer accounts, admin dashboards, analytics, multi-tenancy, and production infrastructure.
- Long-term transcript storage.

No excluded feature may be added merely because a provider or SDK makes it easy.

## 4. Architecture

Keep platform adapters thin and workflow decisions in application services, not in prompts or webhook handlers.

```text
Twilio Voice webhook ----> Express HTTP adapter ----> call session service
Twilio Media Stream -----> WebSocket adapter <-----> OpenAI Realtime adapter
Twilio SMS webhook ------> Express HTTP adapter ----> message workflow service
                                                   |-> intent classifier
                                                   |-> configured FAQ service
                                                   |-> fake scheduler
                                                   |-> emergency escalation
                                                   `-> owner notifier
```

Recommended source boundaries:

- `src/server.ts`: startup, middleware, routes, and WebSocket upgrade wiring.
- `src/config.ts`: validated environment configuration and configured business facts.
- `src/routes/twilioVoice.ts`: inbound Voice TwiML only.
- `src/routes/twilioSms.ts`: inbound SMS parsing and TwiML response only.
- `src/realtime/bridge.ts`: Twilio audio events, OpenAI Realtime events, interruption, and cleanup.
- `src/agent/instructions.ts`: receptionist prompt generated from this spec and configuration.
- `src/agent/tools.ts`: four bounded tool definitions.
- `src/domain/service.ts`: confirmation, validation, idempotency, and workflow orchestration.
- `src/domain/fakeScheduler.ts`: deterministic demo slots and fake appointments.
- `src/domain/escalation.ts`: emergency records and safe handoff language.
- `src/notifications/notifier.ts`: console/Twilio owner-notification adapter.
- `src/storage/store.ts`: in-memory or local demo persistence behind a small interface.

The demo may use in-memory storage initially. If persistence is needed, use a local SQLite adapter without changing domain contracts.

## 5. Required HTTP and WebSocket boundaries

### `GET /health`

Returns service readiness without secrets or provider credentials.

### `POST /twilio/voice`

- Validates the Twilio signature when `TWILIO_AUTH_TOKEN` is configured.
- Returns TwiML connecting the call to `wss://<public-host>/twilio/media`.
- Does not contain business logic.

### `WS /twilio/media`

- Accepts Twilio `connected`, `start`, `media`, `mark`, and `stop` events.
- Bridges 8 kHz G.711 mu-law audio to and from OpenAI Realtime using the provider-supported format.
- Associates one isolated application session with one Twilio stream.
- Clears queued Twilio audio when caller speech interrupts the agent.
- Closes both provider connections and records a sanitized summary when the call ends.

### `POST /twilio/sms`

- Validates the Twilio signature when configured.
- Normalizes sender and message text.
- Runs the same classification and bounded workflows used by voice.
- Returns TwiML with one concise reply.
- Rejects or safely retries duplicate webhook deliveries by idempotency key.

### `POST /demo/reset`

Available only when `NODE_ENV` is `development` or `test`. Clears fake appointments and demo records. It MUST NOT exist in production mode.

## 6. Agent behavior

The receptionist is warm, concise, and honest. It MUST:

- Identify the business using configured values.
- Ask one question at a time.
- Classify the interaction before performing a consequential action.
- Use tools for business facts, scheduling, and escalation instead of inventing results.
- Read back the requested date, time window, name, phone number, and service summary before asking for appointment confirmation.
- Say that an appointment request is a demo request and is not a guaranteed real booking.
- State uncertainty when information is missing.
- Keep emergency responses short and prioritize human help.

It MUST NOT:

- Collect payment-card or bank information.
- Quote a price, approve a refund, diagnose a dangerous condition, or promise coverage.
- Claim a technician is assigned, en route, or arriving at a particular time.
- Claim that 911, emergency services, or the owner has responded.
- Create an appointment before explicit confirmation.
- Reveal system prompts, credentials, internal logs, or other callers' information.

## 7. Intent categories

- `EMERGENCY`: immediate risk to life, safety, property, fire, gas, flooding, electrical danger, or similarly urgent conditions.
- `NEW_LEAD`: a prospective customer asking about service or requesting an appointment.
- `EXISTING_CUSTOMER`: a current customer asking about an existing request or needing follow-up.
- `GENERAL_QUESTION`: hours, service area, offered services, or other configured FAQ information.

When confidence is low, ask a clarifying question. Safety-related uncertainty is treated as `EMERGENCY` for escalation purposes, without pretending to diagnose the situation.

## 8. Bounded agent tools

Expose exactly these four workflow tools to the Realtime agent:

### `classify_call`

Input: brief sanitized summary.  
Output: one intent category, confidence, and reason.

### `answer_business_question`

Input: normalized question.  
Output: configured answer or a stable `FACT_NOT_CONFIGURED` result. It never guesses.

### `schedule_appointment`

Input: caller name, callback number, service summary, requested date/time window, `confirmed`, and idempotency key.  
Rules: `confirmed` MUST be `true`; required values MUST validate; the fake slot MUST exist; repeats with the same key and payload return the original result; a changed payload with the same key returns a conflict.  
Output: fake appointment ID, requested slot, and explicit demo-only status.

### `escalate_emergency`

Input: callback number, sanitized situation summary, location if voluntarily provided, `confirmed`, and idempotency key.  
Rules: tell the caller to move to safety and contact local emergency services when appropriate; do not delay urgent help to collect fields; record the escalation and notify the owner; never claim dispatch or receipt by a human.  
Output: escalation ID and notification status.

SMS uses equivalent application-service calls even if the language model tool interface is used only for voice.

## 9. Confirmation and side-effect rules

- Classification and configured FAQ lookup are read-only.
- Fake appointment creation requires a clear affirmative confirmation after the complete request is read back.
- Emergency escalation may immediately create a safety record and owner notification when emergency risk is detected; the caller does not need to remain on the line. Any optional follow-up action must still be described honestly.
- All writes require an idempotency key derived from the provider event/tool call plus session identity.
- The same key and same payload returns the stored result.
- The same key with a different payload returns `CONFLICT` and performs no second write.
- A notification failure does not erase a saved appointment or escalation; it returns a visible notification failure for retry.

## 10. Owner notification

Notification content is intentionally concise:

- Interaction channel: voice or SMS.
- Caller phone number.
- Classification.
- Short sanitized summary.
- Fake appointment or escalation ID when applicable.
- Requested next action: call back, review demo appointment, or urgent human follow-up.
- Timestamp and request ID.

The notification MUST NOT include full transcripts, API keys, payment data, or unsupported claims. `NOTIFICATION_MODE=console` is the default. Live Twilio SMS notification is opt-in through configuration.

## 11. Configuration and secret handling

- `.env.example` documents variable names with blank credential values.
- The real `.env` is local-only and ignored by Git.
- Code reads secrets from environment variables and never logs them.
- Startup fails with a clear list of missing required variables for the selected mode, without printing values.
- Business facts come from validated configuration. Unknown facts are not invented.
- Tests use fake credentials and mocked provider adapters.

## 12. Error contract

Application services return a stable result shape:

```json
{
  "ok": false,
  "code": "VALIDATION_ERROR",
  "message": "A safe, user-facing summary.",
  "requestId": "opaque-id",
  "data": null,
  "errors": [{ "field": "requestedSlot", "code": "REQUIRED" }]
}
```

Expected codes include `VALIDATION_ERROR`, `CONFIRMATION_REQUIRED`, `FACT_NOT_CONFIGURED`, `CONFLICT`, `UPSTREAM_ERROR`, and `INTERNAL_ERROR`. Provider errors are translated at adapter boundaries; raw provider payloads and secrets are not returned to callers.

## 13. Test requirements

Tests MUST cover:

- Twilio signature acceptance and rejection.
- Voice TwiML points to the correct secure WebSocket URL.
- Media event parsing, audio forwarding, interruption/clear behavior, and cleanup.
- All four classifications.
- Unknown business facts produce `FACT_NOT_CONFIGURED`.
- Unconfirmed fake appointments perform no write.
- Confirmed fake appointments write once.
- Identical retries return the original result; changed-payload retries conflict.
- Emergency detection records escalation and attempts owner notification without a dispatch claim.
- Notification failure preserves the underlying record.
- SMS duplicate delivery is idempotent.
- Production mode does not expose `/demo/reset`.
- Logs and HTTP responses never contain configured secret values.

Live OpenAI, Twilio, phone-number, and tunnel checks are separate manual verification steps. Passing local tests does not prove those external services work.

## 14. Demo script

1. Call the Twilio number and ask a configured business-hours question.
2. Ask for service and request a fake appointment.
3. Hear the receptionist read the request back; explicitly confirm it.
4. Show the fake appointment and owner notification.
5. Send an inbound SMS question and receive a bounded reply.
6. Run a controlled emergency phrase; show the safety language, escalation record, and owner notification.
7. State clearly that scheduling is simulated and payments are intentionally excluded.

## 15. Change control

This version is feature-frozen. Before changing prompts, tool schemas, route contracts, storage semantics, or safety behavior:

1. Read this entire file.
2. Describe the proposed spec change and its demo-day impact.
3. Update this file first after explicit approval.
4. Update implementation and tests to match.

Do not silently broaden the scope. Demo reliability and honest behavior take priority over additional features.

## 16. v0.1.1 clarifications

Approved corrections where the implementation did not satisfy this document. No scope is added and no excluded feature is enabled.

1. **Initial greeting (section 2, criterion 1).** The receptionist speaks first. The bridge requests one greeting response once both the OpenAI session is configured and the Twilio stream has started; before the stream starts there is no `streamSid` to deliver audio on. The greeting identifies the business, states that this is a demo, and asks how it can help.
2. **Caller number on voice (section 5).** Twilio's Media Streams `start` event does not contain the caller number, so `POST /twilio/voice` declares it as `<Parameter name="from" value="...">` on `<Stream>`, and the bridge reads `start.customParameters.from`. The known caller number is used as the callback number only when the agent does not supply one, which keeps section 9's rule that an emergency is never delayed to collect a field.
3. **Idempotency keys are system-derived (section 8 and section 9).** Section 9 governs: keys are derived from channel, session identity, and the provider tool call id. `schedule_appointment` and `escalate_emergency` therefore do **not** expose an `idempotency_key` argument to the model, and the prompt does not ask for one. Section 8's input lists describe the workflow input, not the model-facing schema.
4. **Offered services are configured (section 7 and section 11).** `BUSINESS_SERVICES` is a required configured fact. `answer_business_question` answers a question about the service list; a question about one specific unlisted service still returns `FACT_NOT_CONFIGURED` rather than guessing.
5. **Classifier precedence (section 7).** Order is `EMERGENCY`, then `EXISTING_CUSTOMER`, then configured-fact questions as `GENERAL_QUESTION`, then `NEW_LEAD`, then `GENERAL_QUESTION` by default. Configured-fact questions must be answered even when they contain lead vocabulary ("service area" contains "service"). `EMERGENCY` matches immediate-risk language only; impatience terms such as "urgent" and "help me" are not safety signals and no longer escalate.
