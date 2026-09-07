// Worker tuning knobs, kept separate from processing logic so they can be
// scanned/adjusted without reading the batch-processing control flow.

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs(attempt: number): number;
}

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 5,
  // 2, 4, 8, then capped at 15 min for attempt 4 (the last delay computed —
  // attempt 5 exhausts maxAttempts and dead-letters instead of retrying).
  backoffMs: (attempt) => Math.min(15 * 60_000, 60_000 * 2 ** attempt),
};

// How long a claim is honored before another worker may treat it as
// abandoned (e.g. the claimant crashed) and reclaim the job. Must stay well
// above realistic processing time, or a slow-but-alive worker could have its
// own claim stolen out from under it.
export const DEFAULT_CLAIM_VISIBILITY_MS = 60_000;
