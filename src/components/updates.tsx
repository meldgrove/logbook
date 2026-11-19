"use client";

import { fetchTransport, UpdatesProvider, type UpdatesTransport } from "@meldgrove/ui/updates";

const DEPLOYMENT_GUIDE = "https://github.com/meldgrove/logbook/blob/main/docs/deployment.md#automatic-updates";

const routes = fetchTransport({ url: "/api/admin/updates" });

/**
 * The routes under /api/admin/updates answer 404 (JSON) without an admin
 * session, as the admin pages do. The update button stops asking only on
 * 401 and 403, so Logbook's 404 counts as 401. A 404 without JSON (from a
 * proxy) stays a refusal.
 */
const transport: UpdatesTransport = {
  async request(request) {
    const answer = await routes.request(request);
    if (answer.status !== 404 || answer.data === null) return answer;
    return { status: 401, data: { error: "Your session ended. Sign in again as an admin." } };
  },
};

/**
 * The update status of the page, shared by the update button in the header
 * and the Updates card on the admin page. Admins only.
 */
export function LogbookUpdates({ children }: { children: React.ReactNode }) {
  return (
    <UpdatesProvider
      appName="Logbook"
      project="logbook"
      transport={transport}
      guideUrl={DEPLOYMENT_GUIDE}
      storageKey="logbook.updates"
    >
      {children}
    </UpdatesProvider>
  );
}
