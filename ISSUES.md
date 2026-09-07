# Issues and chosen scope

I treated this as an inherited system and looked for the risks that break the
invariants the README calls out for the _real_ partner integration. Below is the
prioritized list, then the coherent slice I chose to fix within the timebox.

## Prioritized issues

### P0 — Broken access control (any customer can read any application) — FIXED

`getApplication` looked up the application by `id` only. The route checked that
an `x-customer-id` header was _present_ but never that the caller _owned_ the
application. Any customer could read anyone's loan, contact details, and history.
This directly violates "one customer must never be able to read another
customer's application."

- Fix: scope the read by `customerId`; return `404` (not `403`) so the API does
  not disclose that an inaccessible id exists.

### P0 — No idempotency on partner events (retries duplicate everything) — FIXED

`recordStatusEvent` never checked whether an `eventId` had already been recorded.
A partner retry (same `eventId`) appended a second history row and queued a
second notification every time. Violates "an accepted logical event should have
exactly one effect on the history and request at most one notification."

- Fix: inside a transaction, short-circuit when this application already has a
  history row for the `eventId` (idempotent no-op returning the current
  application). Idempotency is scoped **per application** with a
  `@@unique([applicationId, sourceEventId])` constraint, so the same `eventId`
  on a different application is not wrongly dropped as a duplicate; a concurrent
  duplicate hits `P2002` and is treated as a duplicate.

### P0 — Out-of-order events corrupt current state — FIXED

`recordStatusEvent` always overwrote `status`/`lastEventOccurredAt` with the last
HTTP request, so a late/older event clobbered the current state. Violates
"current state must describe the newest accepted business event."

- Fix: compare business time. A **stale** (older) event was never applied, so it
  has **no effect** — no state change, no notification, and nothing written to
  the customer-facing history — and is signalled distinctly as `409` with
  outcome `stale` (a `200` would wrongly imply it took effect). A newer event
  advances state and notifies (`202`, outcome `accepted`).

### P1 — Events could reopen a terminal application — FIXED

With only a timestamp check, a newer event against a `DISBURSED`/`DECLINED`
application would be accepted, flipping a finished loan back to (e.g.)
`SUBMITTED` and emailing the customer. Violates DOMAIN.md's plain statement that
`DECLINED` and `DISBURSED` are terminal.

- Fix: after the duplicate check and before the staleness check, reject any
  event whose application is already terminal (`409`, outcome `terminal`). This
  is a single spec-stated fact (a `Set` of terminal statuses), **not** a full
  transition graph, and it holds even for a newer timestamp.

### P1 — Non-atomic write (partial state on crash) — FIXED

The three writes (update application, insert history, insert job) ran as separate
statements. A crash between them left history/state/notification inconsistent.

- Fix: wrap the accepted-event path in a single `prisma.$transaction`.

### P1 — No state-machine transition validation (illegal jumps accepted) — FIXED

Only the terminal-state check existed. A newer-timestamped event naming an
illegal edge (e.g. `SUBMITTED -> APPROVED`, or `OFFERED -> IN_REVIEW` moving
backward) still advanced state, because ordering only compared timestamps, not
the lifecycle graph. Violates DOMAIN.md's stated lifecycle diagram.

- Fix: after the staleness check, reject any event whose `(current status ->
new status)` pair is not one of the exact edges in
  `SUBMITTED -> IN_REVIEW -> OFFERED -> APPROVED -> DISBURSED` (plus `DECLINED`
  from `SUBMITTED`, `IN_REVIEW`, or `OFFERED`). Rejected as a distinct `409`
  outcome, `invalid`, with no effect on state, history, or notifications.

### P1 — Failed notifications are never retried — FIXED

`processNotificationBatch` set `processedAt` in a `finally` block, so a _failed_
delivery was marked processed and never retried. The seeded `@retry.invalid`
customer's job died on the first attempt. Violates "a failed attempt should
remain eligible for a bounded retry policy" and "inspect and replay exhausted
work."

- Fix: on success, set `processedAt`; on failure, keep the job unprocessed and
  set `nextAttemptAt` with exponential backoff. After `maxAttempts`, set
  `deadLetteredAt` so it stops retrying but remains inspectable/replayable. The
  poller now excludes processed and dead-lettered jobs.

### P1 — Concurrent workers could both deliver the same notification — FIXED

`processNotificationBatch` read eligible jobs, called the provider, and only
_afterward_ wrote `processedAt` — a classic check-then-act. Two worker
processes polling at the same time could both read the same row and both call
the provider before either persisted its result. Violates DOMAIN.md's
"multiple worker processes may eventually run at the same time" combined with
"request at most one customer notification" per event.

- Fix: claim a job with a single atomic `updateMany(WHERE processedAt IS NULL
AND ...)` before acting on it; a losing worker's `WHERE` matches zero rows
  and it skips the job instead of also calling the provider. The finishing
  writes (success and failure) re-check the same claim ownership, so a claim
  that goes stale while a send is still in flight is caught instead of being
  silently miscounted as a clean, exclusive delivery. A `claimedAt` visibility
  timeout reclaims a job whose claimant crashed mid-flight. This does not, by
  itself, prevent a genuine double-send if the visibility window truly elapses
  mid-send — only a real provider's own durable idempotency key can (see
  DESIGN.md) — it prevents that scenario from corrupting the job's
  bookkeeping or being reported as a clean success.

### P2 — Mock notification provider silently ignored its own idempotency key — FIXED

`MockEmailProvider.sendStatusUpdate` accepted an `idempotencyKey` parameter but
never read it, so calling it twice with the same key (e.g. a retry within the
same process) sent twice with no client-side backstop at all.

- Fix: track seen keys in an in-memory `Set` and skip re-sending for a key
  already seen. This only covers same-process re-delivery — a fresh instance
  (a real crash+restart) starts empty, so it does not, and cannot, simulate
  crash-durable idempotency; that has to come from a real provider's own
  server-side dedup.

### P2 — `NotificationJob` had no uniqueness guarantee of its own — FIXED (hardening)

`NotificationJob` only indexed `sourceEventId`; only `ApplicationStatusHistory`
had `@@unique([applicationId, sourceEventId])`. A duplicate job was already
prevented in practice because both rows are written in the same transaction
and the history insert's unique constraint fails first — but that guarantee
depended on every future writer going through that exact code path, and
`ApplicationStatusHistory.sourceEventId` being nullable meant even its own
constraint had a "multiple `NULL`s aren't equal" loophole.

- Fix: added `@@unique([applicationId, sourceEventId])` directly on
  `NotificationJob`, and made `ApplicationStatusHistory.sourceEventId`
  non-nullable. "One job/one history row per event" is now a real database
  invariant, not an implicit property of one code path.

### P2 — Web homepage always redirected to a hardcoded application — FIXED

`apps/web/app/page.tsx` unconditionally redirected to `app_home_001`, one
specific seeded customer's application. Switching the demo identity
(`DEMO_CUSTOMER_ID`) to any other seeded customer made every homepage visit
404, since ownership is correctly enforced and that customer doesn't own that
application.

- Fix: added `GET /v1/applications` (scoped by `x-customer-id`, same ownership
  pattern as the existing single-application read) and had the homepage
  redirect to whichever application the API actually returns for the current
  customer, instead of a hardcoded id.

## Deliberately left alone (with reasons)

- **Partner adapter authentication.** DOMAIN.md states auth of the partner
  adapter is out of scope for the exercise; I describe its trust boundary in
  DESIGN.md instead.
- **Web authentication / customer switching.** The `x-customer-id` header is a
  deliberate demo stand-in; changing it is out of scope.
- **Localization / money formatting.** Confirmed working via manual smoke
  testing (see TOOLING.md), not just left assumed; not a stated risk, so left
  as-is rather than adding automated coverage.
- **Dead-letter replay endpoint.** Dead-lettered jobs are inspectable via the
  database (`deadLetteredAt` is set, nothing is deleted), but replaying one
  (clearing the marker and resetting `nextAttemptAt`) is not yet exposed via an
  API/CLI — see DESIGN.md.

## How I verified

`pnpm check` (lint + typecheck + test + build) is green. New focused tests cover
each fixed behavior — see `PLAN.md` for the exact list.
