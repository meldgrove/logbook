import { useSyncExternalStore } from "react";
import { adoptInstall, installKey, type PendingInstall } from "@/lib/updates/state";
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
}

const PENDING_KEY = "logbook.updates.installing";
const SERVER_SNAPSHOT: UpdatesSnapshot = { response: null, pending: null, offline: false, at: 0, followed: null };

let snapshot: UpdatesSnapshot | null = null;
/** The installation the admin stopped waiting for (`installKey`): a status that reports it does not bring it back. */
let stopped: string | null = null;
const listeners = new Set<() => void>();

function readPending(): PendingInstall | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null") as PendingInstall | null;
    return value && typeof value.version === "string" && typeof value.startedAt === "number" && typeof value.confirmed === "boolean"
      ? value
      : null;
  } catch {
    return null;
  }
}

function writePending(pending: PendingInstall | null): void {
  try {
    if (pending) sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Without sessionStorage, a reload stops waiting; the updater still installs.
  }
}

function getSnapshot(): UpdatesSnapshot {
  snapshot ??= { response: null, pending: readPending(), offline: false, at: Date.now(), followed: null };
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
  if ("pending" in change) writePending(change.pending ?? null);
  for (const listener of listeners) listener();
}

/**
 * Shows an answer with the updater's status (from a poll, a check, a refused
 * request, or the channel), and follows an installation it reports.
 */
export function receiveUpdates(response: UpdatesResponse, change: Partial<UpdatesSnapshot> = {}): void {
  const pending = "pending" in change ? (change.pending ?? null) : getSnapshot().pending;
  const adopted = adoptInstall(pending, response.reachable ? response.updater : null, Date.now(), stopped);
  setUpdates({ ...change, response, ...(adopted !== pending ? { pending: adopted, followed: null } : {}) });
}

/** Forgets the installation the button waits for; normal polling goes on. */
export function stopWaiting(): void {
  const { pending, response } = getSnapshot();
  const installing = response?.updater?.installing;
  if (installing && installing.version === pending?.version) stopped = installKey(installing);
  setUpdates({ pending: null, offline: false });
}

export function useUpdates(): UpdatesSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
}

/** Calls one of the routes under /api/admin/updates. */
export async function requestUpdates(
  action: "status" | "check" | "install" | "channel",
  body?: Record<string, string>,
): Promise<UpdatesRequestResult> {
  let response: Response;
  try {
    response = await fetch(action === "status" ? "/api/admin/updates" : `/api/admin/updates/${action}`, {
      method: action === "status" ? "GET" : "POST",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    return { kind: "outage" };
  }
  if (response.status >= 500) return { kind: "outage" };
  const json = (await response.json().catch(() => null)) as (Partial<UpdatesResponse> & { error?: string }) | null;
  if (!response.redirected && json && typeof json.reachable === "boolean") {
    return { kind: "answer", httpStatus: response.status, body: json as UpdatesResponse };
  }
  if (response.redirected || response.status === 401 || response.status === 404) {
    return { kind: "signed-out", message: "Your session ended. Sign in again as an admin." };
  }
  if (response.status === 403) return { kind: "signed-out", message: json?.error ?? "Logbook refused the request." };
  return { kind: "error", message: json?.error ?? `Logbook answered HTTP ${response.status}.` };
}
