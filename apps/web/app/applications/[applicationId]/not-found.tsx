import Link from "next/link";

export default function ApplicationNotFound() {
  return (
    <main className="page-shell">
      <div className="state-message">
        <h1>Application not found</h1>
        <p>
          We couldn&apos;t find that application, or it doesn&apos;t belong to
          your account.
        </p>
        <Link href="/">Back home</Link>
      </div>
    </main>
  );
}
