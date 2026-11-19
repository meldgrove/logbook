import { SidebarInset, SidebarProvider } from "@meldgrove/ui/sidebar";
import { UpdatesProvider } from "@meldgrove/ui/updates";
import { cookies } from "next/headers";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { displayPreferences, type DateFormat } from "@/lib/preferences";
import { getMyTasks } from "@/lib/process/queries";

/** Set by the sidebar (`@meldgrove/ui/sidebar`) when it is opened or collapsed. */
const SIDEBAR_COOKIE = "sidebar_state";

const DEPLOYMENT_GUIDE = "https://github.com/meldgrove/logbook/blob/main/docs/deployment.md#automatic-updates";

/** The locale whose dates read like each date format; en-GB (19 Nov 2026) for YYYY-MM-DD. */
const DATE_LOCALES: Record<DateFormat, string> = {
  "DD.MM.YYYY": "de-DE",
  "YYYY-MM-DD": "en-GB",
  "DD/MM/YYYY": "en-GB",
  "MM/DD/YYYY": "en-US",
};

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
          // Dates in the person's date format and time zone, as everywhere in the app.
          dateLocale={DATE_LOCALES[displayPreferences(person).dateFormat]}
          timeZone={displayPreferences(person).timeZone}
        >
          {inset}
        </UpdatesProvider>
      ) : (
        inset
      )}
    </SidebarProvider>
  );
}
