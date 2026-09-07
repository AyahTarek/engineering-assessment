# Tooling

## AI assistants

- **GitHub Copilot (agent mode) — models:** Claude Opus 4.8, Claude Sonnet 5
- **Cursor**
- **ChatGPT** — used as a supplementary sounding board alongside the
  Copilot/Cursor implementation-and-review loop, for illustrating and
  clarifying/visualizing concepts and reasoning rather than for implementation.

Used as a pair, not just one model in isolation: one model/session implemented
the fix, then a second, different model acted as an **LLM-as-a-Judge**,
independently reviewing the first's changes and claims (e.g. state-machine
check ordering, idempotency scope, concurrent-worker claiming) rather than
trusting a single model's self-assessment. Every such review was treated as
a claim to verify, not a fact — I re-read the actual code/schema for each
point raised, confirmed which parts were real gaps versus already-covered or
overstated, and only then decided to fix, document, or dismiss it.

### How I used it

- **Understand first.** Read every source file (API, worker, web, contracts,
  Prisma schema, seed, tests, config) before changing anything, and mapped each
  README/DOMAIN invariant to a specific line of code.
- **Prioritize.** Ranked issues by impact on the stated invariants (data leakage
  and correctness first, reliability next) and picked one coherent slice.
- **Implement narrowly.** Applied DRY/KISS/YAGNI: scoped a read query, added an
  idempotency check + transaction, a time-based ordering guard, and a retry/
  dead-letter policy — no speculative abstractions.
- **Prove.** Added targeted tests for each behavior (ownership, idempotency,
  ordering, retry, dead-letter).

### How I checked the AI's output

- **Treated every suggestion as a proposal, not a directive.** For each
  AI-generated change I decided whether to accept it as-is, fine-tune it, or
  reject it outright. Where a model's suggestion diverged from what I had in
  mind — e.g. a different scope for the idempotency check, a broader
  abstraction than the slice needed — I discussed the tradeoff directly with
  it (its stated best-practice rationale vs. my own design intent, weighed
  against DRY/KISS/YAGNI) before deciding which way to go.
- Ran `pnpm check` (which chains `lint` -> `typecheck` -> `test` -> `build`) after
  each change, and `pnpm test` on its own for faster iteration in between —
  all green.
- Ran `pnpm dev` (api + web + worker together) to exercise real HTTP/DB behavior
  for the manual/Postman testing below, not just the automated suite.
- Wrote tests that would fail under the _old_ behavior (e.g. cross-customer read,
  duplicate `eventId`, out-of-order event, failed-then-retried job) so the tests
  actually discriminate the fix rather than just passing.
- Reviewed every generated edit by hand for correctness and for security
  (existence non-disclosure via `404`, transactional integrity, no PII in logs).

## Manual and exploratory testing

- **Postman.** Mocked partner `POST /v1/applications/:applicationId/status-events`
  calls to drive an application through its lifecycle end-to-end and manually
  verified every outcome/status-code pairing: `accepted` (202), `duplicate`
  (200), `stale` (409), `terminal` (409), `invalid` (409).
- **Notification job timing.** Mocked notification jobs and converted the
  stored `nextAttemptAt` timestamp to a readable datetime to confirm each
  retry actually fires on the expected exponential-backoff schedule, not just
  that a value was present.
- **Provider failure simulation.** Used the `@retry.invalid` recipient
  convention (env-driven) to force provider failures, then switched back to a
  normal recipient partway through the retry sequence to confirm a
  previously-failing job can still succeed on a later attempt.
- **Dead-letter exhaustion.** Kept a recipient on the failing path through
  `maxAttempts` to confirm the job is dead-lettered and excluded from further
  polling.
- **Customer switching.** Used the `DEMO_CUSTOMER_ID` env var to switch between seeded customers, matching this demo's actual mechanism for simulating a signed-in customer (a real auth session, in production). To make a switch persist across restarts rather than only for a single in-memory run, I set the value directly in the app's `.env` file (instead of passing it inline on the command line) and restarted the dev server so the new value was picked up.
- **Prisma Studio.** Used for direct database inspection/manipulation (`pnpm
db:studio`) during manual end-to-end smoke testing, outside of the seed
  script — e.g. checking rows written by Postman-driven status events, and
  manually adjusting `claimedAt`/`nextAttemptAt` to force retry/reclaim paths.
- **Web UI / money formatting.** While driving status events through Postman,
  loaded the corresponding application page in the browser and visually
  confirmed `requestedAmountCents` renders correctly as EGP currency and the
  status badge reflects the latest accepted event.

## Other tools

- **pnpm** workspaces / scripts (`pnpm check`, `db:reset`, `db:generate`).
- **Prisma** for schema + client regeneration after the composite
  `@@unique([applicationId, sourceEventId])` / `deadLetteredAt` changes.
- **Vitest** via `pnpm test` for the focused tests, run against a dedicated `test.db`.
