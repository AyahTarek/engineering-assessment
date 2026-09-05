import { redirect } from "next/navigation";
import { fetchMyApplications } from "../src/api";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const data = await fetchMyApplications();
  console.log(data);

  const [mostRecent] = await fetchMyApplications();
  if (!mostRecent) {
    return (
      <main className="page-shell">
        <div className="state-message">
          <h1>No applications yet</h1>
          <p>We couldn&apos;t find any loan applications for this account.</p>
        </div>
      </main>
    );
  }

  redirect(`/applications/${mostRecent.id}`);
}
