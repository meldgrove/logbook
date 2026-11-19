"use client";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@meldgrove/ui/breadcrumb";
import { Separator } from "@meldgrove/ui/separator";
import { SidebarTrigger } from "@meldgrove/ui/sidebar";
import { UpdateButton } from "@meldgrove/ui/updates";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useSyncExternalStore } from "react";
import { breadcrumbsFor } from "@/lib/navigation";

const noSubscription = () => () => {};

/** False on the server and while the page hydrates, true after. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
}

interface AppHeaderProps {
  /** Admins see the update button (inside `LogbookUpdates`). */
  isAdmin: boolean;
}

/** The sidebar toggle, where the page sits in the app, and, for admins, the update button. */
export function AppHeader({ isAdmin }: AppHeaderProps) {
  const crumbs = breadcrumbsFor(usePathname());
  const hydrated = useHydrated();
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      {crumbs.length > 0 ? (
        <>
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <Breadcrumb className="min-w-0">
            <BreadcrumbList>
              {crumbs.map((crumb, index) => (
                <Fragment key={crumb.label}>
                  {index > 0 ? <BreadcrumbSeparator /> : null}
                  <BreadcrumbItem>
                    {crumb.href ? (
                      <BreadcrumbLink asChild>
                        <Link href={crumb.href}>{crumb.label}</Link>
                      </BreadcrumbLink>
                    ) : (
                      <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        </>
      ) : null}
      {isAdmin ? (
        <div className="ml-auto flex shrink-0 items-center">
          {/* Only after hydration: the button reads an installation this tab follows from
              sessionStorage, which the server cannot see, so its server HTML would not match. */}
          {hydrated ? <UpdateButton /> : null}
        </div>
      ) : null}
    </header>
  );
}
