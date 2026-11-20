"use client";

import { AppFrame, type NavGroup } from "@meldgrove/ui/app-frame";
import { useThemePreference } from "@meldgrove/ui/theme";
import { UpdateButton } from "@meldgrove/ui/updates";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOutAction } from "@/app/actions";
import { LogoMark } from "@/components/logo";
import { findEntries } from "@/lib/entries/search";
import { timelineHref } from "@/lib/entries/timeline-filters";
import { breadcrumbsFor, navSections } from "@/lib/navigation";

interface LogbookFrameProps {
  user: { name: string; email: string | null };
  /** Admins see the administration and the update button (inside the layout's UpdatesProvider). */
  isAdmin: boolean;
  /** What waits for the person, as a count at "My tasks". */
  taskCount: number;
  /** The cookie `sidebar_state`, read on the server. */
  defaultSidebarOpen: boolean;
  children: React.ReactNode;
}

const search = { find: findEntries, allResultsHref: (q: string) => timelineHref({ q }) };

/**
 * The frame of `@meldgrove/ui` with Logbook's navigation: a client component,
 * because the frame takes the router's link and functions, which cannot come
 * from the server layout.
 */
export function LogbookFrame({ user, isAdmin, taskCount, defaultSidebarOpen, children }: LogbookFrameProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [theme, setTheme] = useThemePreference();
  const badge =
    taskCount > 0 ? (
      <>
        {taskCount}
        <span className="sr-only"> waiting</span>
      </>
    ) : undefined;
  const nav: NavGroup[] = navSections(isAdmin).map((section) => ({
    label: section.label,
    items: section.items.map(({ href, label, shortcut, match, key }) => ({
      href,
      label,
      shortcut,
      match,
      badge: key === "tasks" ? badge : undefined,
    })),
  }));

  return (
    <AppFrame
      app={{ name: "Logbook", icon: <LogoMark />, description: "Decisions and updates" }}
      nav={nav}
      pathname={pathname}
      link={Link}
      navigate={(href) => router.push(href)}
      user={user}
      theme={theme}
      onThemeChange={setTheme}
      settingsHref="/settings"
      onSignOut={() => void signOutAction()}
      breadcrumbs={breadcrumbsFor(pathname)}
      headerEnd={isAdmin ? <UpdateButton /> : null}
      search={search}
      defaultSidebarOpen={defaultSidebarOpen}
    >
      {children}
    </AppFrame>
  );
}
