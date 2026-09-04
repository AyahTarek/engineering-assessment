"use client";

import { useEffect } from "react";

export default function ApplicationError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server Component errors are sanitized before reaching this boundary in
    // production; the digest is the only way to correlate with server logs.
    console.error(error);
  }, [error]);

  return (
    <main className="page-shell">
      <div className="state-message">
        <h1>Something went wrong</h1>
        <p>We couldn&apos;t load this application right now.</p>
        <button type="button" onClick={() => reset()}>
          Try again
        </button>
      </div>
    </main>
  );
}
