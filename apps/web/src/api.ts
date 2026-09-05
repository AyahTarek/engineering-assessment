import type { ApplicationStatus, ApplicationView } from "@assessment/contracts";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:3001";
const demoCustomerId = process.env.DEMO_CUSTOMER_ID ?? "cus_amina_001";

export interface ApplicationSummary {
  id: string;
  status: ApplicationStatus;
  updatedAt: string;
}

// Applications actually owned by the signed-in customer, newest first — lets
// the homepage pick a real application instead of a hardcoded id.
export async function fetchMyApplications(): Promise<ApplicationSummary[]> {
  const response = await fetch(`${apiUrl}/v1/applications`, {
    cache: "no-store",
    headers: { "x-customer-id": demoCustomerId },
  });

  if (!response.ok) {
    throw new Error(`Applications request failed with ${response.status}`);
  }

  const body = (await response.json()) as {
    applications: ApplicationSummary[];
  };
  return body.applications;
}

export async function fetchApplication(
  applicationId: string,
): Promise<ApplicationView | null> {
  const response = await fetch(`${apiUrl}/v1/applications/${applicationId}`, {
    cache: "no-store",
    headers: { "x-customer-id": demoCustomerId },
  });

  // Missing and not-owned are both 404 by design (see application-service.ts);
  // the caller renders this as "not found", not as an error.
  if (response.status === 404) return null;

  if (!response.ok) {
    throw new Error(`Application request failed with ${response.status}`);
  }

  return (await response.json()) as ApplicationView;
}

export function formatStatus(status: ApplicationStatus): string {
  return status
    .toLowerCase()
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
