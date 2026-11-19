import { useSyncExternalStore } from "react";
import { adoptInstall, ignoreInstall, type IgnoredInstall, type PendingInstall } from "@/lib/updates/state";
import type { UpdatesRequestResult, UpdatesResponse } from "@/lib/updates/types";

export type { UpdatesRequestResult };

/*
 * The latest answer of /api/admin/updates, shared by the update button and
 * the Updates card, and the installation this browser waits for. The
 * installation is kept in sessionStorage, so a reload during the restart
 * keeps waiting.
 */

export interface UpdatesSnapshot {
  response: UpdatesResponse | null;
  pending: PendingInstall | null;
  /** The latest request during an installation got no answer: Logbook restarts. */
  offline: boolean;
  /** When the latest request ended (ms since the epoch); relative times count from here. */
  at: number;
  /** The installation this browser followed until it failed: the button shows its result. */
  followed: PendingInstall | null;
  /** The admin session ended: the page makes no more automatic requests; `pending` stays for a later page load. */
  signedOut: boolean;
}

const PENDING_KEY = "logbook.updates.installing";
const STOPPED_KEY = "logbook.updates.stopped";
const SERVER_SNAPSHOT: UpdatesSnapshot = { response: null, pending: null, offline: false, at: 0, followed: null, signedOut: false };

let snapshot: UpdatesSnapshot | null = null;
/** The installation the admin stopped waiting for: a status that reports it does not bring it back. Undefined: not read yet. */
let stopped: IgnoredInstall | null | undefined;
const listeners = new Set<() => void>();

function read<T>(key: string, valid: (value: T) => boolean): T | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null") as T | null;
    return value && valid(value) ? value : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    // Without sessionStorage, a reload stops waiting; the updater still installs.
  }
}

function readPending(): PendingInstall | null {
  const value = read<Partial<PendingInstall>>(
    PENDING_KEY,
    (v) => typeof v.version === "string" && typeof v.startedAt === "number" && typeof v.confirmed === "boolean",
  );
  return value && ({ installingSince: null, earlier: null, sawOutage: false, reason: null, lastError: null, ...value } as PendingInstall);
}

function stoppedInstall(): IgnoredInstall | null {
  if (stopped === undefined) {
    stopped = read<IgnoredInstall>(STOPPED_KEY, (v) => typeof v.version === "string" && typeof v.since === "number");
  }
  return stopped;
}

function getSnapshot(): UpdatesSnapshot {
  snapshot ??= { response: null, pending: readPending(), offline: false, at: Date.now(), followed: null, signedOut: false };
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentUpdates(): UpdatesSnapshot {
  return getSnapshot();
}

export function setUpdates(change: Partial<UpdatesSnapshot>): void {
  snapshot = { ...getSnapshot(), at: Date.now(), ...change };
  if ("pending" in change) write(PENDING_KEY, change.pending ?? null);
  for (const listener of listeners) listener();
}

/**
 * Shows an answer with the updater's status (from a poll, a check, a refused
 * request, or the channel), and follows an installation it reports.
 */
export function receiveUpdates(response: UpdatesResponse, change: Partial<UpdatesSnapshot> = {}): void {
  const pending = "pending" in change ? (change.pending ?? null) : getSnapshot().pending;
  const adopted = adoptInstall(pending, response.reachable ? response.updater : null, Date.now(), stoppedInstall());
  setUpdates({ ...change, response, ...(adopted !== pending ? { pending: adopted, followed: null } : {}) });
}

/**
 * Forgets the installation the button waits for, and ignores it from then on
 * by the identity stored on it (also while the updater cannot be reached);
 * normal polling goes on.
 */
export function stopWaiting(): void {
  const { pending } = getSnapshot();
  if (pending) {
    stopped = ignoreInstall(pending);
    write(STOPPED_KEY, stopped);
  }
  setUpdates({ pending: null, offline: false });
}

/** One automatic status request (page load, interval, focus); none after the admin session ended. */
export async function pollUpdates(request = requestUpdates): Promise<void> {
  if (getSnapshot().signedOut) return;
  const result = await request("status");
  if (result.kind === "answer") receiveUpdates(result.body);
  else if (result.kind === "signed-out") setUpdates({ signedOut: true });
}

export function useUpdates(): UpdatesSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
}

const SESSION_ENDED = "Your session ended. Sign in again as an admin.";

function isUpdatesResponse(json: unknown): json is UpdatesResponse {
  return typeof json === "object" && json !== null && typeof (json as { reachable?: unknown }).reachable === "boolean";
}

/** A sign-in page instead of JSON: a redirect, or HTML. */
function isSignInPage(response: Response): boolean {
  return response.redirected || (response.headers.get("content-type") ?? "").includes("text/html");
}

function noAnswer(error: unknown, timeoutMs: number | undefined): string {
  if (timeoutMs && error instanceof Error && error.name === "TimeoutError") {
    const seconds = Math.ceil(timeoutMs / 1000);
    return `Logbook did not answer within ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
  }
  return "Logbook could not be reached.";
}

/**
 * Calls one of the routes under /api/admin/updates. `timeoutMs` bounds the
 * whole request, including its body.
 */
export async function requestUpdates(
  action: "status" | "check" | "install" | "channel",
  body?: Record<string, string>,
  options: { timeoutMs?: number } = {},
): Promise<UpdatesRequestResult> {
  const { timeoutMs } = options;
  let response: Response;
  try {
    response = await fetch(action === "status" ? "/api/admin/updates" : `/api/admin/updates/${action}`, {
      method: action === "status" ? "GET" : "POST",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: timeoutMs ? AbortSignal.timeout(Math.max(1, timeoutMs)) : undefined,
    });
  } catch (error) {
    return { kind: "outage", httpStatus: null, message: noAnswer(error, timeoutMs) };
  }
  const httpStatus = response.status;
  // Null when the answer has no JSON, or broke off.
  const json: unknown = await response.json().catch(() => null);
  const error = typeof json === "object" && json !== null && "error" in json && typeof json.error === "string" ? json.error : null;
  if (httpStatus < 500 && !response.redirected && isUpdatesResponse(json)) return { kind: "answer", httpStatus, body: json };
  if (httpStatus >= 500) return { kind: "outage", httpStatus, message: error ?? `Logbook answered HTTP ${httpStatus}.` };
  if (httpStatus === 403) return { kind: "signed-out", message: error ?? "Logbook refused the request." };
  // Logbook answers 404 (JSON) without an admin session; a proxy's 404 without JSON is just a refusal.
  if (httpStatus === 401 || (httpStatus === 404 && json !== null) || (httpStatus < 400 && isSignInPage(response))) {
    return { kind: "signed-out", message: SESSION_ENDED };
  }
  if (httpStatus >= 400) return { kind: "error", httpStatus, message: error ?? `Logbook answered HTTP ${httpStatus}.` };
  // An answer without Logbook's JSON, or one that broke off: its status still counts (a 202 started the installation).
  return { kind: "outage", httpStatus, message: "Logbook's answer could not be read." };
}
