import { useSyncExternalStore } from "react";
import type { PendingInstall } from "@/lib/updates/state";
import type { UpdatesResponse } from "@/lib/updates/types";

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
}

const PENDING_KEY = "logbook.updates.installing";
const SERVER_SNAPSHOT: UpdatesSnapshot = { response: null, pending: null, offline: false, at: 0 };

let snapshot: UpdatesSnapshot | null = null;
const listeners = new Set<() => void>();

function readPending(): PendingInstall | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null") as PendingInstall | null;
    return value && typeof value.version === "string" && typeof value.startedAt === "number" ? value : null;
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
  snapshot ??= { response: null, pending: readPending(), offline: false, at: Date.now() };
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

export function useUpdates(): UpdatesSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
}

export type UpdatesRequestResult =
  | { kind: "answer"; httpStatus: number; body: UpdatesResponse }
  /** No answer, or 502/503/504: Logbook restarts (or the network is down). */
  | { kind: "outage" }
  /** Another answer, such as 404 after the session ended. */
  | { kind: "error"; message: string };

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
  if (response.status === 502 || response.status === 503 || response.status === 504) return { kind: "outage" };
  const json = (await response.json().catch(() => null)) as (Partial<UpdatesResponse> & { error?: string }) | null;
  if (json && typeof json.reachable === "boolean") return { kind: "answer", httpStatus: response.status, body: json as UpdatesResponse };
  return { kind: "error", message: json?.error ?? `Logbook answered HTTP ${response.status}.` };
}
