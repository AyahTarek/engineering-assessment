import { notFound } from "next/navigation";
import { fetchApplication, formatStatus } from "../../../src/api";

export const dynamic = "force-dynamic";

function formatMoney(amountInCents: number, currency: string) {
  return new Intl.NumberFormat("en-EG", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amountInCents / 100);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-EG", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default async function ApplicationPage({
  params,
}: {
  params: Promise<{ applicationId: string }>;
}) {
  const { applicationId } = await params;
  const application = await fetchApplication(applicationId);

  if (!application) notFound();

  return (
    <main className="page-shell">
      <div className="page-title">
        <div>
          <h1>Loan application</h1>
          <p className="application-id">{application.id}</p>
        </div>
        <span className={`status status-${application.status.toLowerCase()}`}>
          {formatStatus(application.status)}
        </span>
      </div>

      <section className="summary" aria-labelledby="summary-title">
        <h2 id="summary-title">Summary</h2>
        <dl className="summary-list">
          <div>
            <dt>Requested amount</dt>
            <dd>
              {formatMoney(
                application.requestedAmountCents,
                application.currency,
              )}
            </dd>
          </div>
          <div>
            <dt>Applicant</dt>
            <dd>{application.customer.name}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{application.customer.email}</dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd>{application.customer.phone}</dd>
          </div>
        </dl>
      </section>

      <section className="history" aria-labelledby="history-title">
        <h2 id="history-title">Status history</h2>
        <div className="table-frame">
          <table>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Reason</th>
                <th scope="col">Effective at</th>
              </tr>
            </thead>
            <tbody>
              {application.history.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatStatus(entry.status)}</td>
                  <td>{entry.reason ?? "—"}</td>
                  <td>{formatDate(entry.occurredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
