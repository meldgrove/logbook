import { SidebarInset, SidebarProvider } from "@meldgrove/ui/sidebar";
import { cookies } from "next/headers";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { LogbookUpdates } from "@/components/updates";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { getMyTasks } from "@/lib/process/queries";

/** Set by the sidebar (`@meldgrove/ui/sidebar`) when it is opened or collapsed. */
const SIDEBAR_COOKIE = "sidebar_state";

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
      {/* The update button in the header and the Updates card on /admin share one status. */}
      {person.isAdmin ? <LogbookUpdates>{inset}</LogbookUpdates> : inset}
    </SidebarProvider>
  );
}
