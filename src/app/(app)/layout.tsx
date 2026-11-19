import { SidebarInset, SidebarProvider } from "@meldgrove/ui/sidebar";
import { UpdatesProvider } from "@meldgrove/ui/updates";
import { cookies } from "next/headers";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { displayPreferences } from "@/lib/preferences";
import { getMyTasks } from "@/lib/process/queries";

/** Set by the sidebar (`@meldgrove/ui/sidebar`) when it is opened or collapsed. */
const SIDEBAR_COOKIE = "sidebar_state";

const DEPLOYMENT_GUIDE = "https://github.com/meldgrove/logbook/blob/main/docs/deployment.md#automatic-updates";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { person } = await requireUser();
  const [tasks, cookieStore] = await Promise.all([getMyTasks(getDb(), person.id), cookies()]);
  // SidebarInset is a plain container: the page content gets its own <main>, the header stays outside.
  const inset = (
    <SidebarInset className="min-w-0">
      <AppHeader isAdmin={person.isAdmin} />
      <main className="flex-1 px-4 py-6 md:px-8">
        <div className="mx-auto w-full max-w-5xl">{children}</div>
      </main>
    </SidebarInset>
  );
  return (
    <SidebarProvider defaultOpen={cookieStore.get(SIDEBAR_COOKIE)?.value !== "false"}>
      <AppSidebar user={{ name: person.displayName, email: person.workEmail }} isAdmin={person.isAdmin} taskCount={tasks.length} />
      {person.isAdmin ? (
        // The update button in the header and the Updates card on /admin share one status.
        <UpdatesProvider
          appName="Logbook"
          project="logbook"
          url="/api/admin/updates"
          guideUrl={DEPLOYMENT_GUIDE}
          // Month first or day first, as the person's date format. Not "de-DE" for DD.MM.YYYY:
          // the package writes relative times ("5 minutes ago") in this locale too.
          dateLocale={displayPreferences(person).dateFormat === "MM/DD/YYYY" ? "en-US" : "en-GB"}
        >
          {inset}
        </UpdatesProvider>
      ) : (
        inset
      )}
    </SidebarProvider>
  );
}
