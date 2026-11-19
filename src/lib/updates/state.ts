import type { Update, UpdaterStatus, UpdatesResponse } from "./types";

/*
 * What the update button and the Updates card show, as pure functions of the
 * answer of /api/admin/updates (docs/deployment.md, Automatic updates).
 */

export type ButtonState =
  /** Before the first answer. */
  | "loading"
  | "checking"
  | "up-to-date"
  | "available"
  | "attention"
  | "installing"
  | "failed"
  | "off"
  | "unreachable";

/** An installation this browser asked for and waits for, kept in sessionStorage across reloads. */
export interface PendingInstall {
  version: string;
  /** `app.version` when it was asked for. */
  fromVersion: string | null;
  /** `finishedAt` of the updater's last result before, so an older result for the same version does not count. */
  previousResult: string | null;
  /** When it was asked for (ms since the epoch). */
  startedAt: number;
  /** Logbook did not answer at least once since: it restarted. */
  sawOutage: boolean;
}

/** After this long without a result, the button says so. */
export const INSTALL_PATIENCE_MS = 15 * 60_000;

export const CHANNEL_LABELS = { stable: "Stable", preview: "Preview" } as const;

export function buttonState(
  response: UpdatesResponse | null,
  local: { checking: boolean; pending: PendingInstall | null },
): ButtonState {
  if (local.pending) return "installing";
  if (!response) return local.checking ? "checking" : "loading";
  const status = response.updater;
  if (!response.reachable || !status) return local.checking ? "checking" : "unreachable";
  if (status.installing) return "installing";
  if (local.checking || status.checking) return "checking";
  if (status.mode === "off") return "off";
  if (failure(status)) return "failed";
  if (status.available) return "available";
  if (status.attention) return "attention";
  return "up-to-date";
}

/** States whose click opens the popover; a click on the others checks for updates. */
export function hasPopover(state: ButtonState): boolean {
  return state === "available" || state === "attention" || state === "installing" || state === "failed";
}

/** The failed installation the button shows: the last one failed and the version is still offered. */
export function failure(status: UpdaterStatus): { version: string; message: string } | null {
  const last = status.last;
  if (!last || (last.result !== "failed" && last.result !== "rolled-back")) return null;
  const offered = status.available?.failed ? status.available : status.attention?.failed ? status.attention : null;
  if (!offered) return null;
  return { version: last.version, message: last.message ?? offered.failed! };
}

/** The version shown as installed: the updater's, or Logbook's own. */
export function installedVersion(response: UpdatesResponse): string | null {
  return response.updater?.installed ?? response.app.version;
}

/** The tooltip, also the button's accessible name. */
export function buttonLabel(state: ButtonState, response: UpdatesResponse | null, pending: PendingInstall | null): string {
  const status = response?.updater;
  switch (state) {
    case "loading":
      return "Check for updates";
    case "checking":
      return "Checking for updates…";
    case "up-to-date": {
      const installed = response ? installedVersion(response) : null;
      return installed ? `Up to date · ${installed}` : "Up to date";
    }
    case "available":
      return `Update available · ${status!.available!.version}`;
    case "attention":
      return `${status!.attention!.version} needs upgrade steps`;
    case "installing":
      return `Installing ${pending?.version ?? status?.installing?.version ?? ""}…`;
    case "failed":
      return `Update to ${failure(status!)!.version} failed`;
    case "off":
      return "Automatic updates are off on this server";
    case "unreachable":
      return "No update service. See the deployment guide.";
  }
}

export type InstallOutcome = "waiting" | "done" | "failed";

/**
 * Whether an installation this browser asked for has ended. Done when
 * Logbook runs the version, or the updater says it installed it (host: the
 * new version is healthy). A platform only accepted it, so then Logbook must
 * run another version or have restarted. Failed when the updater says so.
 */
export function installOutcome(pending: PendingInstall, response: UpdatesResponse): InstallOutcome {
  if (response.app.version === pending.version) return "done";
  const last = response.updater?.last;
  if (!last || last.version !== pending.version || last.finishedAt === pending.previousResult) return "waiting";
  switch (last.result) {
    case "failed":
    case "rolled-back":
      return "failed";
    case "installed":
      return "done";
    case "accepted":
      return response.app.version !== pending.fromVersion || pending.sawOutage ? "done" : "waiting";
  }
}

/** What the server is doing during an installation. */
export function stageLabel(stage: string, previousVersion: string | null): string {
  switch (stage) {
    case "requested":
      return "Waiting for the server";
    case "pulling":
      return "Downloading";
    case "starting":
      return "Starting";
    case "rolling-back":
      return previousVersion ? `Going back to ${previousVersion}` : "Going back";
    case "deploying":
      return "Deploying";
    default:
      return stage;
  }
}

/** "just now", "5 min ago", "3 hours ago", "2 days ago". */
export function timeAgo(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** The line about when an update installs by itself, or null when it does not. */
export function installsAtText(installsAt: string | null, now: number, formatDateTime: (value: Date) => string): string | null {
  if (!installsAt) return null;
  const at = new Date(installsAt);
  if (Number.isNaN(at.getTime())) return null;
  return at.getTime() <= now ? "Installs automatically at the next check" : `Installs automatically on ${formatDateTime(at)}`;
}

/** How many changes the popover leaves out after showing `shown` notes. */
export function moreChanges(update: Update, shown: number): number {
  return Math.max(update.changes, update.notes.length) - Math.min(shown, update.notes.length);
}

const UNITS = { d: ["day", 86_400], h: ["hour", 3_600], m: ["minute", 60] } as const;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** The updater's duration setting in words: "3d" is "3 days", "90" (seconds) "90 seconds"; null for none. */
export function durationText(value: string | null): string | null {
  const match = value ? /^\s*(\d+)\s*([dhms]?)\s*$/.exec(value) : null;
  if (!match) return value;
  const count = Number(match[1]);
  if (count === 0) return null;
  const unit = match[2];
  if (unit === "d" || unit === "h" || unit === "m") return plural(count, UNITS[unit][0]);
  for (const [name, seconds] of Object.values(UNITS)) {
    if (count % seconds === 0) return plural(count / seconds, name);
  }
  return plural(count, "second");
}

/** The help text of the Stable channel. */
export function stableHelp(cooldown: string | null): string {
  const after = durationText(cooldown);
  return `Releases. Updates that need no action install automatically${after ? ` after ${after}` : ""}.`;
}

export const PREVIEW_HELP =
  "Unstable: every change on main as soon as its checks pass, before it is released. New features first, and now and then a new bug. Previews have no release notes.";

/** Whether and when updates install by themselves. */
export function automaticText(status: UpdaterStatus): string {
  if (status.mode === "off" || !status.automatic) return "Off on this server: nothing installs automatically.";
  const what = status.channel === "preview" ? "releases and previews install" : "releases install";
  const after = durationText(status.cooldown);
  const [from, to] = status.window?.split("-") ?? [];
  const window = from && to ? `, between ${from.trim()} and ${to.trim()} (${status.timezone})` : "";
  const platform = status.mode === "platform" ? " The platform installs them (deploy link)." : "";
  return `On: ${what} automatically${after ? ` after ${after}` : ""}${window}.${platform}`;
}
