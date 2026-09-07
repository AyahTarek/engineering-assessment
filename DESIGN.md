# Production design

This describes how I would evolve the exercise into a production loan-status
system. It builds on the slice already implemented (ownership checks, event
idempotency, ordering, transactional writes, bounded retry + dead-letter).

## Boundaries

Three trust zones:

1. **Partner ingress (internal integration adapter).** Receives partner status
   events. Untrusted payloads; trusted network only after authentication.
2. **Customer API (public).** Serves customer-owned reads (a single application,
   and the caller's own application list via `GET /v1/applications`). Every
   request is authorized against the authenticated subject.
3. **Async processing (worker).** Consumes durable jobs and calls the email
   provider. No direct external input.

Keeping ingress and customer read paths separate lets them scale, deploy, and be
secured independently. In production I would split the partner endpoint onto its
own route/service with its own auth and rate limits.

## Idempotency and ordering

- **Idempotency key = partner `eventId`.** Enforced by a unique constraint on the
  event log (`sourceEventId`) plus a transactional pre-check. Retries are safe
  no-ops. Under Postgres I would use `INSERT ... ON CONFLICT DO NOTHING` and
  branch on whether a row was inserted.
- **Notification uniqueness is a database invariant, not just transaction
  ordering.** `NotificationJob` has its own `@@unique([applicationId,
sourceEventId])` (not just an index), and `ApplicationStatusHistory.sourceEventId`
  is non-nullable (SQL treats every `NULL` as distinct, so a nullable column's
  unique constraint doesn't stop multiple `NULL` rows). Together these make
  "one job/one history row per event" hold regardless of what writes the row
  in the future (seed, replay, admin tools), not just the current
  `recordStatusEvent` transaction.
- **Why `type` isn't part of that unique key.** `NotificationJob.type` is
  always `"APPLICATION_STATUS_CHANGED"` today, so including it would be a
  no-op for current behavior — but it would weaken the invariant, not
  strengthen it: a future bug that created a second job for the same event
  under a different `type` value would then bypass the constraint instead of
  hitting `P2002`. The real rule is "one job per event," full stop. If a
  future design deliberately fans one event out to multiple independent jobs
  (e.g. email + SMS as separately retryable/dead-letterable jobs), that's a
  different invariant — "one job per event per channel" — and should be a
  conscious schema change with its own comment, not a quiet key addition.
- **Ordering by business time.** The immutable history stores every accepted
  event; current state only advances when `occurredAt` is newer than the last
  accepted event, so late/out-of-order deliveries never regress state.
- **State machine enforcement.** Only the edges in
  `SUBMITTED -> IN_REVIEW -> OFFERED -> APPROVED -> DISBURSED` (plus `DECLINED`
  from `SUBMITTED`, `IN_REVIEW`, or `OFFERED`) are legal; any other pair
  (backward move, skipped step, or restating the current status) is rejected
  as a distinct `invalid` outcome, separate from `stale`/`terminal`, without
  touching state, history, or notifications. For stricter guarantees under
  concurrent writers I would still add an optimistic version/sequence column.
- **One logical change = one transaction.** State + history + outbox row commit
  together (see below).

## Notifications: outbox, retries, dead letters

- **Transactional outbox.** The notification job is written in the _same_
  transaction as the state change (already done), so a notification is never lost
  or emitted without a committed state change.
- **Bounded retry with backoff.** Failed deliveries stay eligible and are retried
  with exponential backoff and jitter (implemented; jitter is a small addition).
- **Dead-letter queue.** After `maxAttempts`, jobs are marked `deadLetteredAt` and
  excluded from polling. Operators can inspect them and replay by clearing the
  dead-letter marker and resetting `nextAttemptAt`. A one-off CLI script could
  do this, but I'd rather expose it as an internal admin panel: replay is an
  operator action on production data, and a panel gives you auth, an audit
  trail of who replayed what and when, and a list/filter view of dead-lettered
  jobs — a CLI would need all of that re-built or would ship without it.
- **Provider idempotency.** The provider call carries an idempotency key
  (`sourceEventId`), which is what a _real_ provider's own durable, server-side
  dedup would use to make a crash-after-accept-but-before-persist safe. Our
  local mock only dedupes within one process's lifetime (an in-memory set),
  so it does not, and cannot, simulate that durability across a crash+restart
  — there is no client-side fix for that; it has to come from the provider.
- **Concurrent workers.** Implemented: `processNotificationBatch` claims a job
  with a single `UPDATE ... WHERE processedAt IS NULL AND ...` before acting
  on it, checking the affected-row count — a losing worker matches zero rows
  and skips the job instead of also calling the provider. The finishing writes
  (success and failure) re-check the same claim ownership the same way, so a
  claim that goes stale _while a send is still in flight_ (visibility window
  too tight, or a genuinely slow call) is caught too — the late finisher sees
  `count === 0`, logs it, and does not count its own send as a clean exclusive
  delivery or overwrite whatever the reclaiming worker already wrote. A
  `claimedAt` visibility timeout reclaims a job whose claimant crashed
  mid-flight, so a crash can't strand a job forever. This works on SQLite
  today because it's a single atomic statement, not row-level locking; moving
  to Postgres would be about throughput (real concurrent claiming via
  `SELECT ... FOR UPDATE SKIP LOCKED`, or a broker), not about closing a
  correctness gap. What this does _not_ close: if the visibility window
  actually elapses mid-send, the job **is** genuinely sent twice by two
  workers — the ownership re-check stops that from being miscounted or
  double-recorded, it doesn't stop the second real send. Preventing that
  outright needs the same durable, provider-side idempotency key described
  above; keeping the window comfortably larger than realistic send time (as
  the default does) makes it very unlikely in practice, not impossible.

## Authorization and sensitive data

- **Customer API.** Replace the `x-customer-id` header with a real authenticated
  session (OIDC/JWT). Authorize every read against the subject; return `404` for
  not-owned resources to avoid existence disclosure (already the behavior).
- **Partner ingress.** Authenticate the adapter (mTLS or signed requests / HMAC
  with a shared secret and timestamp to prevent replay), allow-list source IPs,
  and rate-limit. This is the trust boundary DOMAIN.md asks us to describe.
- **PII.** Email/phone are sensitive. Encrypt at rest, restrict logging (log ids,
  not contact details), and apply retention policies. Notification payloads
  should reference the event, not embed contact details.

## Auditability and observability

- **Audit.** The append-only history is the customer-visible audit trail; I would
  also emit an internal audit log (who/what/when) for admin actions like replay.
- **Metrics.** Ingest rate, duplicate rate, accepted-vs-stale ratio, job queue
  depth, delivery success/failure, dead-letter count, retry age.
- **Tracing/logging.** Correlate partner `eventId` -> state change -> job ->
  provider call with a trace id. Structured logs, no PII.
- **Alerts.** Rising dead-letter count, queue depth/age, provider error rate.

## Deployment, migrations, rollback

- **Database.** SQLite -> Postgres. Use versioned migrations (`prisma migrate`)
  in CI/CD rather than `db push`. Make schema changes backward compatible
  (expand/contract) so app and DB can deploy independently.
- **Deployment.** Separate deployables for API, partner ingress, and worker.
  Roll out API before worker when contracts change. Health/readiness probes.
- **Rollback.** Backward-compatible migrations allow app rollback without a DB
  rollback. The outbox + idempotency make redelivery after rollback safe.

## Tradeoffs I would postpone

- Real message broker vs. DB-backed queue — start with Postgres `SKIP LOCKED`,
  move to a broker only when throughput demands it (YAGNI).
- Provider idempotency is keyed on `eventId`; if the same event legitimately
  produces multiple notification types, the key would need `type` too.
- Multi-region, encryption key rotation, and data-residency — real but not on the
  critical correctness path for a first production cut.
