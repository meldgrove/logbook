"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { UpdateButton } from "@/components/updates/update-button";
import { breadcrumbsFor } from "@/lib/navigation";
import type { DisplayPreferences } from "@/lib/preferences";

interface AppHeaderProps {
  /** Admins see the update button. */
  isAdmin: boolean;
  preferences: DisplayPreferences;
}

/** The sidebar toggle, where the page sits in the app, and, for admins, the update button. */
export function AppHeader({ isAdmin, preferences }: AppHeaderProps) {
  const crumbs = breadcrumbsFor(usePathname());
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
          <UpdateButton preferences={preferences} />
        </div>
      ) : null}
    </header>
  );
}
