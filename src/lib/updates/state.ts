import type { Update, UpdaterStatus, UpdatesRequestResult, UpdatesResponse } from "./types";

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

type LastResult = NonNullable<UpdaterStatus["last"]>;
type Installing = NonNullable<UpdaterStatus["installing"]>;

/**
 * An installation this browser follows, kept in sessionStorage across
 * reloads: one it asked for (remembered before the request), or one the
 * updater reports.
 */
export interface PendingInstall {
  version: string;
  /** When it was asked for, or when the updater started it (ms since the epoch). Results finished before do not count. */
  startedAt: number;
  /** `installing.startedAt` once a status reported it: with the version, the installation's identity. */
  installingSince: string | null;
  /** The `last` of the newest status before it started (the earlier result): never a result of this installation. */
  earlier: LastResult | null;
  /** The updater accepted it (202) or reports it. False while the answer to the request was unclear. */
  confirmed: boolean;
  /** Logbook or the updater did not answer at least once since: it restarted. */
  sawOutage: boolean;
  /** Why the request got no clear answer; shown when the installation did not start. */
  reason: string | null;
  /** While unconfirmed: the error of the latest request that got no status; null when a reachable status answered last. */
  lastError: string | null;
}

/** After this long without a result, the button says so and offers to stop waiting. */
export const INSTALL_PATIENCE_MS = 15 * 60_000;

/** How long an installation without a clear answer to its request may take to show up in the status. */
export const RECONCILE_MS = 60_000;

/** A page loaded after that minute still asks this long before it gives up on an unconfirmed attempt. */
export const RESUME_MS = 10_000;

const NO_ANSWER = "Logbook did not answer.";

/**
 * An installation this browser asks for, remembered before the request.
 * `latest` is the newest answer: its `last` is the earlier result.
 */
export function newAttempt(version: string, now: number, latest: UpdatesResponse | null): PendingInstall {
  return {
    version,
    startedAt: now,
    installingSince: null,
    earlier: latest?.updater?.last ?? null,
    confirmed: false,
    sawOutage: false,
    reason: null,
    lastError: NO_ANSWER,
  };
}

export const CHANNEL_LABELS = { stable: "Stable", preview: "Preview" } as const;

export function buttonState(
  response: UpdatesResponse | null,
  local: { checking: boolean; pending: PendingInstall | null; followed?: PendingInstall | null },
): ButtonState {
  if (local.pending) return "installing";
  if (!response) return local.checking ? "checking" : "loading";
  const status = response.updater;
  if (!response.reachable || !status) return local.checking ? "checking" : "unreachable";
  if (status.installing) return "installing";
  if (local.checking || status.checking) return "checking";
  const failed = failure(status, local.followed);
  // A failure of a version no longer offered gives way to a newer offer, which names it (`failureNote`).
  if (failed && (failed.update || (!status.available && !status.attention))) return "failed";
  // Also with automatic updates off: the updater still offers new versions.
  if (status.available) return "available";
  if (status.attention) return "attention";
  if (status.mode === "off") return "off";
  return "up-to-date";
}

/** Whether the updater can install: with automatic updates off, it refuses. */
export function canInstall(status: UpdaterStatus): boolean {
  return status.mode !== "off";
}

/** States whose click opens the popover; a click on the others checks for updates. */
export function hasPopover(state: ButtonState): boolean {
  return state === "available" || state === "attention" || state === "installing" || state === "failed";
}

/** The offer of `version`: `available` or `attention`. */
function offer(status: UpdaterStatus, version: string): Update | null {
  if (status.available?.version === version) return status.available;
  if (status.attention?.version === version) return status.attention;
  return null;
}

/** Whole seconds, as the updater writes its times. */
function wholeSeconds(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

function sameResult(a: LastResult, b: LastResult | null): boolean {
  return b !== null && a.version === b.version && a.result === b.result && a.finishedAt === b.finishedAt;
}

/**
 * `last` when it is a result of `pending` ("fresh"): of its version, not the
 * earlier result, and finished at or after the installation started: at
 * `installing.startedAt` when a status reported it, otherwise at the
 * attempt's start cut to whole seconds.
 */
function resultOf(pending: PendingInstall, status: UpdaterStatus | null): UpdaterStatus["last"] {
  const last = status?.last;
  if (!last || last.version !== pending.version || sameResult(last, pending.earlier)) return null;
  const reported = pending.installingSince ? Date.parse(pending.installingSince) : Number.NaN;
  const since = Number.isNaN(reported) ? wholeSeconds(pending.startedAt) : reported;
  return Date.parse(last.finishedAt) >= since ? last : null;
}

/**
 * The failed installation the button shows: the last one failed or went
 * back, and the updater still offers the version with that failure, or this
 * browser followed the installation (`followed`). `update` is the offer to
 * try again, while the version is still offered.
 */
export function failure(
  status: UpdaterStatus,
  followed: PendingInstall | null = null,
): { version: string; message: string; update: Update | null } | null {
  const last = status.last;
  if (!last || (last.result !== "failed" && last.result !== "rolled-back")) return null;
  const update = offer(status, last.version);
  if (!update?.failed && !(followed && resultOf(followed, status) === last)) return null;
  return { version: last.version, message: last.message ?? update?.failed ?? "The installation failed.", update };
}

/**
 * The line an offer of a newer version keeps about the failure of a version
 * that is no longer offered: "0.2.1 failed: <message>".
 */
export function failureNote(status: UpdaterStatus, followed: PendingInstall | null = null): string | null {
  const failed = failure(status, followed);
  return failed && !failed.update ? `${failed.version} failed: ${failed.message}` : null;
}

/**
 * Why a manual check failed, in every state: the route's error (the updater
 * refused, or cannot be reached), or the updater's own; null when it worked.
 */
export function checkError(response: UpdatesResponse): string | null {
  if (response.error) return response.error;
  if (!response.reachable || !response.updater) return "The update service is not reachable.";
  return response.updater.error ? `The check failed: ${response.updater.error}` : null;
}

/**
 * What the popover offers for an update: "install" (Install now), "anyway"
 * (an attention offer: Install anyway…), "locked" (an attention offer that the
 * image tag set where Logbook is deployed does not reach), or "off" (the
 * updater installs nothing).
 */
export function installAction(status: UpdaterStatus, update: Update): "install" | "anyway" | "locked" | "off" {
  if (!canInstall(status)) return "off";
  if (update.version !== status.attention?.version) return "install";
  return status.channelLocked === null ? "anyway" : "locked";
}

/** The version shown as installed: the updater's, or Logbook's own. */
export function installedVersion(response: UpdatesResponse): string | null {
  return response.updater?.installed ?? response.app.version;
}

/** The tooltip, also the button's accessible name. */
export function buttonLabel(
  state: ButtonState,
  response: UpdatesResponse | null,
  pending: PendingInstall | null,
  followed: PendingInstall | null = null,
): string {
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
      return `Update to ${failure(status!, followed)!.version} failed`;
    case "off":
      return "Automatic updates are off on this server";
    case "unreachable":
      return "No update service. See the deployment guide.";
  }
}

export type InstallOutcome = "waiting" | "done" | "failed";

/**
 * Whether a confirmed installation has ended, from an answer with the
 * updater's status that arrived after it started. In this order: a fresh
 * result that failed or went back; still installing (also when Logbook
 * already answers with the new version: on a server the result comes only
 * after every service is healthy, and it may still go back); installed;
 * accepted by a platform, once Logbook runs the version (without a version
 * of its own: once it answered after an outage); and, when nothing reports
 * the installation any more, Logbook runs the version.
 */
export function installOutcome(pending: PendingInstall, response: UpdatesResponse): InstallOutcome {
  const status = response.updater;
  const last = resultOf(pending, status);
  if (last?.result === "failed" || last?.result === "rolled-back") return "failed";
  if (status?.installing?.version === pending.version) return "waiting";
  if (last?.result === "installed") return "done";
  const app = response.app.version;
  if (last?.result === "accepted") return app === pending.version || (app === null && pending.sawOutage) ? "done" : "waiting";
  return app === pending.version ? "done" : "waiting";
}

/** `pending`, confirmed by a status that reports it installing, with that installation's identity. */
function reportedBy(pending: PendingInstall, installing: Installing): PendingInstall {
  return pending.confirmed && pending.installingSince === installing.startedAt
    ? pending
    : { ...pending, confirmed: true, installingSince: installing.startedAt };
}

/** The installation the updater reports in `status`, to follow unless the admin stopped waiting for it (`ignored`). */
export function adoptInstall(
  pending: PendingInstall | null,
  status: UpdaterStatus | null,
  now: number,
  ignored: IgnoredInstall | null = null,
): PendingInstall | null {
  const installing = status?.installing;
  if (!installing) return pending;
  if (pending?.version === installing.version) return reportedBy(pending, installing);
  if (isIgnored(installing, ignored)) return pending;
  const startedAt = Date.parse(installing.startedAt);
  return {
    version: installing.version,
    startedAt: Number.isNaN(startedAt) ? now : startedAt,
    installingSince: installing.startedAt,
    earlier: status.last,
    confirmed: true,
    sawOutage: false,
    reason: null,
    lastError: null,
  };
}

/**
 * An installation the admin stopped waiting for: its version and
 * `installing.startedAt`, or, when no status reported it, every installation
 * of the version that started from the attempt's start (`since`) on.
 */
export interface IgnoredInstall {
  version: string;
  installingSince: string | null;
  since: number;
}

/** Stops following `pending` for good: by the identity stored on it, also while the updater is unreachable. */
export function ignoreInstall(pending: PendingInstall): IgnoredInstall {
  return { version: pending.version, installingSince: pending.installingSince, since: wholeSeconds(pending.startedAt) };
}

export function isIgnored(installing: Installing, ignored: IgnoredInstall | null): boolean {
  if (!ignored || installing.version !== ignored.version) return false;
  return ignored.installingSince !== null
    ? installing.startedAt === ignored.installingSince
    : Date.parse(installing.startedAt) >= ignored.since;
}

/**
 * What follows from the answer to the install request of `attempt`: 202
 * confirms it, also when its body cannot be read; a 4xx refuses it and
 * forgets it, unless the status it carries reports another installation
 * (another admin or an automatic one was faster), which is followed
 * instead; any other answer (no answer, 5xx, unreadable, 200 without the
 * installation) is unclear, and the attempt waits for the status to report
 * it (`followInstall`, `reconcileEnd`). An attempt that a status reported
 * in the meantime stays.
 */
export function afterInstallRequest(
  attempt: PendingInstall,
  result: UpdatesRequestResult,
  now: number,
): { pending: PendingInstall | null; error: string | null } {
  if ((result.kind === "answer" || result.kind === "outage") && result.httpStatus === 202) {
    return { pending: { ...attempt, confirmed: true }, error: null };
  }
  if (attempt.confirmed) return { pending: attempt, error: null };
  const unclear = (reason: string, lastError: string | null = reason) => ({
    pending: { ...attempt, reason, lastError },
    error: null,
  });
  switch (result.kind) {
    case "answer": {
      const { httpStatus, body } = result;
      if (httpStatus >= 400) {
        const other = adoptInstall(null, body.updater, now);
        return other ? { pending: other, error: null } : { pending: null, error: body.error ?? "The update service did not start the installation." };
      }
      // 200: no updater answered in time, or a status without the installation.
      const reason = body.error ?? "The update service did not confirm the installation.";
      return body.reachable && body.updater ? unclear(reason, null) : unclear(reason);
    }
    case "outage":
      return unclear(result.message);
    case "signed-out":
    case "error":
      return { pending: null, error: result.message };
  }
}

export type FollowStep =
  /** Keep polling, with this attempt (now perhaps confirmed or after an outage). `offline`: no status this time. */
  | { kind: "wait"; pending: PendingInstall; offline: boolean }
  | { kind: "done"; pending: PendingInstall }
  | { kind: "failed"; pending: PendingInstall }
  /** The admin session ended: stop every automatic request, and keep the attempt for a later page load. */
  | { kind: "signed-out" };

function outage(pending: PendingInstall, error: string): FollowStep {
  return { kind: "wait", pending: { ...pending, sawOutage: true, lastError: error }, offline: true };
}

/**
 * One poll while following `pending`. No answer, 5xx, and no updater are
 * expected while Logbook restarts; each is an outage. An unconfirmed
 * attempt counts once the status reports it (installing, or a fresh
 * result); its deadline is a timer of its own (`reconcileDeadline`).
 */
export function followInstall(pending: PendingInstall, result: UpdatesRequestResult): FollowStep {
  switch (result.kind) {
    case "signed-out":
      return { kind: "signed-out" };
    case "error":
      return { kind: "wait", pending: { ...pending, lastError: result.message }, offline: false };
    case "outage":
      return outage(pending, result.message);
  }
  const response = result.body;
  const status = response.reachable ? response.updater : null;
  if (!status) return outage(pending, response.error ?? "The update service did not answer.");
  if (status.installing?.version === pending.version) pending = reportedBy(pending, status.installing);
  else if (!pending.confirmed && resultOf(pending, status)) pending = { ...pending, confirmed: true };
  if (pending.lastError !== null) pending = { ...pending, lastError: null };
  const outcome = pending.confirmed ? installOutcome(pending, response) : "waiting";
  return outcome === "waiting" ? { kind: "wait", pending, offline: false } : { kind: outcome, pending };
}

/** When the wait for an unconfirmed attempt ends: a minute after it started; a page loaded later still asks a little. */
export function reconcileDeadline(attempt: PendingInstall, now: number): number {
  return Math.max(attempt.startedAt + RECONCILE_MS, now + RESUME_MS);
}

export type ReconcileEnd =
  /** A reachable status answered last, without the installation. */
  | { kind: "not-started"; reason: string }
  /** No status answered after the latest error. */
  | { kind: "unconfirmed"; error: string };

/** How an attempt that is still unconfirmed at its deadline ends. */
export function reconcileEnd(attempt: PendingInstall): ReconcileEnd {
  return attempt.lastError === null
    ? { kind: "not-started", reason: attempt.reason ?? "The update service does not report it." }
    : { kind: "unconfirmed", error: attempt.lastError };
}

/** Whether the wait took so long that the button offers to stop waiting. */
export function isOverdue(pending: PendingInstall, now: number): boolean {
  return now - pending.startedAt >= INSTALL_PATIENCE_MS;
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
