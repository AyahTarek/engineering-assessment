# Plan: what changed, how it was verified, known limits, next steps

## What I changed (one vertical slice: the partner-event trust path)

- **Authorization** — `getApplication` now scopes by `customerId`; the read route
  passes the caller identity and returns `404` for not-owned/unknown ids.
  Files: `apps/api/src/application-service.ts`, `apps/api/src/app.ts`.
- **Idempotency** — `recordStatusEvent` short-circuits a duplicate `eventId` for
  the same application and returns an idempotent result. Scoped with
  `@@unique([applicationId, sourceEventId])` (per application, not global) as a
  race-safe backstop (`P2002` -> duplicate).
  Files: `application-service.ts`, `packages/database/prisma/schema.prisma`.
- **Ordering** — current `status` only advances when `occurredAt` is newer than
  the last accepted event. A stale (older) event has no effect at all — no state
  change, no notification, nothing written to history — and returns `409` with
  `outcome: "stale"`.
- **Atomicity** — the accepted-event writes (history + state + job) run in one
  `prisma.$transaction`.
- **Notification retry / dead-letter** — `processNotificationBatch` no longer
  marks failed jobs processed; it applies exponential backoff and dead-letters
  after `maxAttempts`. Added `NotificationJob.deadLetteredAt`.
  File: `apps/worker/src/process-notifications.ts`.
- **State-machine transition validation** — `recordStatusEvent` now rejects any
  event whose status is not a legal next step from the application's current
  status (per DOMAIN.md's lifecycle diagram), even if its timestamp is newer.
  The transition table and terminal-status check are extracted into their own
  module (`isTerminal`/`canTransition`) so `application-service.ts` only calls
  them, never touches the underlying tables directly.
  Files: `apps/api/src/status-transitions.ts`, `application-service.ts`, `app.ts`.
- **HTTP semantics** — `POST` returns `202` for a newly accepted event, `200`
  with `outcome: "duplicate"` for a retry, and `409` with `outcome: "stale"` or
  `"invalid"` for a superseded or illegal transition.
- **Concurrent worker claiming** — `processNotificationBatch` claims a job with
  an atomic `updateMany(WHERE processedAt IS NULL AND ...)` before acting on
  it, checking the affected-row count; a losing worker matches zero rows and
  skips the job instead of also calling the provider. The finishing writes
  (success and failure) re-check the same claim ownership, so a claim that
  goes stale while a send is still in flight is detected instead of being
  silently miscounted as a clean, exclusive delivery. A `claimedAt` visibility
  timeout (default 60s, configurable) reclaims a job whose claimant crashed
  mid-flight. File: `apps/worker/src/process-notifications.ts`;
  `packages/database/prisma/schema.prisma` (`NotificationJob.claimedAt`).
- **Notification provider idempotency (mock).** `MockEmailProvider` now
  actually honors the `idempotencyKey` it's given (an in-memory set) instead of
  silently ignoring it, so a repeated call in the same process is a no-op.
  This cannot survive a process crash+restart or span multiple worker
  processes — that guarantee has to come from a real provider's own durable,
  server-side dedup (see DESIGN.md). File: `apps/worker/src/notification-provider.ts`.
- **Schema hardening.** `NotificationJob` gained its own
  `@@unique([applicationId, sourceEventId])` (previously only an index), and
  `ApplicationStatusHistory.sourceEventId` was made non-nullable. Both close a
  latent "two `NULL`s aren't equal" loophole in the uniqueness guarantee — not
  exploitable by the current code path, but a real gap for any future writer
  that didn't go through the exact same transaction.
  File: `packages/database/prisma/schema.prisma`.
- **Retry backoff constants corrected.** The default policy's 15-minute cap was
  unreachable within `maxAttempts: 5` (the curve maxed out around 16 seconds
  before exhausting); rescaled to 2/4/8 minutes, hitting the 15-minute cap on
  the last retry. File: `apps/worker/src/process-notifications.ts`.
- **Customer application listing (adjacent fix).** Added `GET /v1/applications`
  (scoped by `x-customer-id`, same ownership pattern as the single-application
  read) so the web app's homepage redirects to an application the signed-in
  demo customer actually owns, instead of a hardcoded id that 404s for any
  customer other than the one it was originally written for.
  Files: `application-service.ts`, `app.ts`, `apps/web/src/api.ts`,
  `apps/web/app/page.tsx`.
- **Cohesion cleanups (no behavior change).** `app.ts`'s outcome -> HTTP status
  map is now a module-level `STATUS_BY_OUTCOME` typed as
  `Record<RecordOutcome, number>`, so an outcome added/renamed in
  `application-service.ts` fails to compile here instead of silently falling
  through with no status code. The worker's tuning knobs (`defaultRetryPolicy`,
  `DEFAULT_CLAIM_VISIBILITY_MS`) moved out of `process-notifications.ts` into
  `apps/worker/src/config.ts`, separating them from the batch-processing
  control flow that reads them.

## How I verified

`pnpm check` (lint + typecheck + test + build) passes. Focused tests added:

- API: missing identity -> `401`; cross-customer read -> `404`;
  duplicate `eventId` -> one history row + one job, `200 duplicate`;
  same `eventId` on two applications -> both accepted (per-application scoping);
  out-of-order (stale) event -> current state unchanged, `409 stale`, nothing
  written to history and no notification; illegal transitions (skipped step,
  backward move) -> `409 invalid`, nothing written to history and no
  notification; two identical requests racing on the same `eventId` -> exactly
  one `accepted` + one `duplicate`, one history row, one notification job;
  listing requires identity (`401`) and returns only the caller's own
  applications.
- API (unit, mocked database): a `P2002` from the concurrent-duplicate race
  (two requests losing the `alreadyRecorded` pre-check) is caught and reported
  as `outcome: "duplicate"`, not a `500`; any other database error still
  propagates instead of being masked as a duplicate.
- Worker: failed delivery stays eligible (`processedAt` null, `nextAttemptAt`
  set, `attemptCount` incremented); exhausted retries -> `deadLetteredAt` set and
  excluded from the next poll; `lastError` is preserved (not cleared) once a
  previously-failing job goes on to succeed, since it records the last failed
  attempt rather than current job health; two concurrent workers racing the
  same job -> the provider is called exactly once and only one delivery is
  recorded; a claim stolen mid-send (visibility window elapsed before
  finishing) is detected and excluded from the delivered count; a stale claim
  from a crashed worker is reclaimed and delivered.
- Worker (provider): a repeated `idempotencyKey` on the same `MockEmailProvider`
  instance is a no-op (one send); a fresh instance (simulating a crash+restart)
  sends again, proving the in-memory dedup does not fake crash durability.
- **Manual/exploratory (not automated).** Beyond the test suite, exercised the
  running API/worker/web (`pnpm dev`) by hand via Postman and Prisma Studio to
  confirm the same behaviors end-to-end against a live process, not just
  in-process test calls — every outcome/status-code pairing, the actual
  backoff schedule's timing, provider-failure-then-recovery mid-retry,
  dead-letter exhaustion, and customer switching. Full detail in TOOLING.md.

Test counts: 14 API (HTTP) + 2 API (service unit) + 7 worker
(process-notifications) + 2 worker (notification-provider) = 25 passing.

## Known limitations

- Retry backoff has no jitter; multiple failing jobs can retry in lockstep.
- `x-customer-id` is still a demo stand-in for a real authenticated session.
- Dead-letter replay is not yet exposed via an endpoint/CLI (design in
  DESIGN.md). A CLI could do it, but a dedicated admin panel is the better
  fit — it's a production data mutation that should carry auth and an audit
  trail, not just a script.
- The claim visibility timeout (`DEFAULT_CLAIM_VISIBILITY_MS`) is a fixed
  constant, not derived from actual observed processing time; if it genuinely
  elapses mid-send, the job **is** sent twice by two workers — the ownership
  re-check stops that from being miscounted, not from happening.
- The mock provider's idempotency-key dedup is in-memory and per-process; it
  does not survive a crash+restart or span multiple worker processes. Real
  crash/multi-process durability requires the provider's own server-side dedup.

## Sensible next steps (in order)

1. Add jitter to retry backoff.
2. Move to Postgres + `SELECT ... FOR UPDATE SKIP LOCKED` (or a broker) for
   real concurrent claiming — a throughput upgrade, not a correctness fix;
   correctness is already covered by the atomic claim.
3. Add an internal admin panel (not just a CLI) to inspect and replay
   dead-lettered jobs with auth and an audit trail, plus an operator-only log
   for "seen but not applied" (stale/invalid) events.
4. Replace the demo identity header with real authentication on the customer API
   and authenticate the partner ingress (mTLS/HMAC).
