import {
  followInstall,
  INSTALL_PATIENCE_MS,
  isOverdue,
  reconcileDeadline,
  reconcileEnd,
  type PendingInstall,
  type ReconcileEnd,
} from "@/lib/updates/state";
import { currentUpdates, receiveUpdates, requestUpdates, setUpdates, type UpdatesSnapshot } from "./updates-store";

export const INSTALL_POLL_MS = 2_000;
const SLOW_INSTALL_POLL_MS = 30_000;
/** How long each status request while following may take; for an unconfirmed attempt, at most the time left. */
export const POLL_TIMEOUT_MS = 10_000;

export type FollowEnd =
  | { kind: "done"; version: string }
  | { kind: "failed" }
  | ReconcileEnd
  /** The admin session ended: the page stops its automatic requests and keeps the attempt for a later page load. */
  | { kind: "signed-out" };

/**
 * Follows the installation the store waits for until it ends: polls the
 * status every 2 seconds (every 30 after 15 minutes), each request with a
 * timeout, and applies `followInstall`. Timers of their own end an
 * unconfirmed attempt at its deadline, whatever the polls return or however
 * long they take, and offer Stop waiting after 15 minutes. Returns a function
 * that stops following.
 */
export function followPending(onEnd: (end: FollowEnd) => void, request = requestUpdates): () => void {
  const start = currentUpdates().pending;
  if (!start) return () => {};
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;
  const later = (run: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, Math.max(0, ms));
    timers.add(timer);
  };
  const stop = () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  const end = (result: FollowEnd) => {
    stop();
    onEnd(result);
  };
  /** The installation, while it is still the one this follows. */
  const current = (): PendingInstall | null => {
    const pending = currentUpdates().pending;
    return pending?.version === start.version && pending.startedAt === start.startedAt ? pending : null;
  };

  const deadline = start.confirmed ? null : reconcileDeadline(start, Date.now());
  if (deadline !== null) {
    later(() => {
      const pending = current();
      if (!pending || pending.confirmed) return;
      setUpdates({ pending: null, offline: false });
      end(reconcileEnd(pending));
    }, deadline - Date.now());
  }

  // Shows the popover's Stop waiting after 15 minutes, also while no poll returns.
  if (!isOverdue(start, Date.now())) {
    later(() => {
      if (current()) setUpdates({});
    }, start.startedAt + INSTALL_PATIENCE_MS - Date.now());
  }

  const tick = async () => {
    const before = current();
    if (!before) return stop();
    // Another request of the page found the session ended.
    if (currentUpdates().signedOut) return end({ kind: "signed-out" });
    const timeoutMs = before.confirmed || deadline === null ? POLL_TIMEOUT_MS : Math.min(POLL_TIMEOUT_MS, deadline - Date.now());
    // No time left: the deadline ends the attempt.
    if (timeoutMs <= 0) return;
    const result = await request("status", undefined, { timeoutMs });
    if (stopped) return;
    const pending = current();
    if (!pending) return stop();
    const step = followInstall(pending, result);
    // Shows the answer, if any, with the change.
    const show = (change: Partial<UpdatesSnapshot>) =>
      result.kind === "answer" ? receiveUpdates(result.body, change) : setUpdates(change);
    switch (step.kind) {
      case "done":
        show({ pending: null, offline: false });
        return end({ kind: "done", version: step.pending.version });
      case "failed":
        show({ pending: null, offline: false, followed: step.pending });
        return end({ kind: "failed" });
      case "signed-out":
        setUpdates({ signedOut: true });
        return end({ kind: "signed-out" });
      case "wait":
        show({ pending: step.pending, offline: step.offline });
    }
    later(() => void tick(), isOverdue(pending, Date.now()) ? SLOW_INSTALL_POLL_MS : INSTALL_POLL_MS);
  };
  later(() => void tick(), INSTALL_POLL_MS);
  return stop;
}
