"use client";

import { Download, ExternalLink, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createDateFormatter } from "@/lib/format";
import type { DisplayPreferences } from "@/lib/preferences";
import {
  afterInstallRequest,
  buttonLabel,
  buttonState,
  CHANNEL_LABELS,
  failure,
  followInstall,
  hasPopover,
  INSTALL_PATIENCE_MS,
  installAction,
  installedVersion,
  installsAtText,
  moreChanges,
  stageLabel,
  timeAgo,
  type ButtonState,
  type PendingInstall,
} from "@/lib/updates/state";
import type { Update, UpdaterStatus, UpdatesResponse } from "@/lib/updates/types";
import { cn } from "@/lib/utils";
import {
  currentUpdates,
  receiveUpdates,
  requestUpdates,
  setUpdates,
  stopWaiting,
  useUpdates,
  type UpdatesRequestResult,
  type UpdatesSnapshot,
} from "./updates-store";

const POLL_MS = 5 * 60_000;
const FOCUS_POLL_MS = 60_000;
const INSTALL_POLL_MS = 2_000;
const SLOW_INSTALL_POLL_MS = 30_000;
const NOTES_SHOWN = 8;

const ERROR_TOAST_MS = 8_000;
const RELOAD_DELAY_MS = 1_500;

interface Toast {
  id: number;
  text: string;
  error: boolean;
}

function requestError(result: Exclude<UpdatesRequestResult, { kind: "answer" }>): string {
  return result.kind === "outage" ? "Logbook could not be reached. Try again in a moment." : result.message;
}

interface Confirmation {
  version: string;
  /** Needs upgrade steps: "Install anyway…". */
  attention: boolean;
  url: string | null;
}

/**
 * The update button in the header, for admins only: checks on click, shows an
 * available update with its changes, installs it on request, and waits until
 * Logbook is back with the new version.
 */
export function UpdateButton({ preferences }: { preferences: DisplayPreferences }) {
  const { response, pending, offline, at, followed } = useUpdates();
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const lastLoad = useRef(0);
  const formatter = useMemo(() => createDateFormatter(preferences), [preferences]);
  // The toast and reload timers, cleared when the button unmounts.
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const later = useCallback((run: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      run();
    }, ms);
    timers.current.add(timer);
  }, []);
  useEffect(() => {
    const pendingTimers = timers.current;
    return () => {
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
    };
  }, []);

  // A check started from the open popover shows in its footer, not on the button.
  const state = buttonState(response, { checking: checking && !open, pending, followed });
  const label = buttonLabel(state, response, pending, followed);
  const popover = hasPopover(state);
  // When there is nothing left to show, the popover closes for good.
  const [hadPopover, setHadPopover] = useState(popover);
  if (popover !== hadPopover) {
    setHadPopover(popover);
    if (!popover) setOpen(false);
  }

  const showError = useCallback(
    (text: string) => {
      const id = Date.now();
      setToast({ id, text, error: true });
      later(() => setToast((shown) => (shown?.id === id ? null : shown)), ERROR_TOAST_MS);
    },
    [later],
  );

  const load = useCallback(async () => {
    lastLoad.current = Date.now();
    const result = await requestUpdates("status");
    if (result.kind === "answer") receiveUpdates(result.body);
  }, []);

  // On page load, every 5 minutes, and when the window regains focus (at most once a minute).
  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), POLL_MS);
    const onFocus = () => {
      if (Date.now() - lastLoad.current >= FOCUS_POLL_MS) void load();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  // While an installation runs: every 2 seconds, through the restart.
  const waitingFor = pending?.version;
  useEffect(() => {
    if (!waitingFor) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const result = await requestUpdates("status");
      if (stopped) return;
      const current = currentUpdates().pending;
      if (current?.version !== waitingFor) return;
      const step = followInstall(current, result, Date.now());
      // Shows the answer, if any, with the change.
      const show = (change: Partial<UpdatesSnapshot>) =>
        result.kind === "answer" ? receiveUpdates(result.body, change) : setUpdates(change);
      switch (step.kind) {
        case "done":
          show({ pending: null, offline: false });
          setToast({ id: Date.now(), text: `Updated to ${current.version}`, error: false });
          later(() => window.location.reload(), RELOAD_DELAY_MS);
          return;
        case "failed":
          show({ pending: null, offline: false, followed: current });
          setOpen(true);
          return;
        case "not-started":
          show({ pending: null, offline: false });
          showError(`The installation did not start. ${step.reason}`);
          return;
        case "signed-out":
          // The attempt stays for the next page load, which signs in again.
          showError("Your session ended. Reload the page and sign in to see how the update went.");
          return;
        case "wait":
          show({ pending: step.pending, offline: step.offline });
      }
      const slow = Date.now() - current.startedAt > INSTALL_PATIENCE_MS;
      timer = setTimeout(tick, slow ? SLOW_INSTALL_POLL_MS : INSTALL_POLL_MS);
    };
    timer = setTimeout(tick, INSTALL_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [waitingFor, later, showError]);

  async function check() {
    setChecking(true);
    const result = await requestUpdates("check");
    setChecking(false);
    if (result.kind !== "answer") return showError(requestError(result));
    receiveUpdates(result.body);
    const failed = result.body.error ?? (result.body.updater?.error ? `The check failed: ${result.body.updater.error}` : null);
    if (failed) showError(failed);
    else if (hasPopover(buttonState(result.body, { checking: false, pending: null }))) setOpen(true);
  }

  async function install({ version }: Confirmation) {
    setConfirmation(null);
    // Remembered before the request: its answer may not arrive although the installation starts.
    const attempt: PendingInstall = { version, startedAt: Date.now(), confirmed: false, sawOutage: false, reason: null };
    setUpdates({ pending: attempt, followed: null, offline: false });
    setOpen(true);
    const result = await requestUpdates("install", { version });
    const current = currentUpdates().pending;
    const body = result.kind === "answer" ? result.body : null;
    if (current?.version !== attempt.version || current.startedAt !== attempt.startedAt) {
      // Ended or replaced while the request ran.
      if (body) receiveUpdates(body);
      return;
    }
    const { pending: next, error } = afterInstallRequest(current, result, Date.now());
    if (body) receiveUpdates(body, { pending: next });
    else setUpdates({ pending: next });
    if (error) showError(error);
  }

  function confirm(update: Update, attention: boolean) {
    setOpen(false);
    setConfirmation({ version: update.version, attention, url: update.url });
  }

  return (
    <>
      <Popover open={open && popover} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="relative rounded-full"
                aria-label={label}
                data-update-state={state}
                onClick={(event) => {
                  if (popover) return;
                  // Nothing to show: the click checks for updates.
                  event.preventDefault();
                  if (state !== "checking") void check();
                }}
              >
                <ButtonIcon state={state} />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end">
            {label}
          </TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 text-sm">
          {response ? (
            <PopoverBody
              state={state}
              response={response}
              pending={pending}
              followed={followed}
              offline={offline}
              now={at}
              formatDateTime={formatter.dateTime}
              onInstall={confirm}
              onStopWaiting={stopWaiting}
            />
          ) : null}
          {response ? <PopoverFooter response={response} now={at} checking={checking} onCheck={() => void check()} /> : null}
        </PopoverContent>
      </Popover>

      <Dialog
        open={confirmation !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmation(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          {confirmation ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {confirmation.attention
                    ? `Install ${confirmation.version} without its upgrade steps?`
                    : `Install ${confirmation.version} now?`}
                </DialogTitle>
                <DialogDescription>
                  {confirmation.attention ? (
                    <>
                      This release changes the setup. Take the upgrade steps from its{" "}
                      {confirmation.url ? (
                        <a href={confirmation.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                          release notes
                        </a>
                      ) : (
                        "release notes"
                      )}{" "}
                      on the server first, or Logbook may not start.{" "}
                    </>
                  ) : null}
                  Logbook restarts and is unavailable for a moment. Database changes run automatically.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button variant={confirmation.attention ? "destructive" : "default"} onClick={() => void install(confirmation)}>
                  {confirmation.attention ? "Install anyway" : "Install"}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {toast ? (
        <div
          role={toast.error ? "alert" : "status"}
          className={cn(
            "fixed right-4 bottom-4 z-50 max-w-[calc(100vw-2rem)] rounded-md border bg-popover px-4 py-3 text-sm font-medium shadow-md sm:max-w-sm",
            toast.error ? "border-destructive/40 text-destructive" : "text-popover-foreground",
          )}
        >
          {toast.text}
        </div>
      ) : null}
    </>
  );
}

function ButtonIcon({ state }: { state: ButtonState }) {
  switch (state) {
    case "checking":
      return <RefreshCw aria-hidden="true" className="text-muted-foreground motion-safe:animate-spin" />;
    case "installing":
      return <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />;
    case "available":
    case "attention":
      return (
        <>
          <Download aria-hidden="true" />
          <span
            aria-hidden="true"
            className={cn(
              "absolute top-1 right-1 size-2 rounded-full ring-2 ring-background",
              state === "available" ? "bg-primary" : "bg-amber-500",
            )}
          />
        </>
      );
    case "failed":
      return <TriangleAlert aria-hidden="true" className="text-destructive" />;
    case "unreachable":
      return <RefreshCw aria-hidden="true" className="text-muted-foreground opacity-60" />;
    default:
      return <RefreshCw aria-hidden="true" className="text-muted-foreground" />;
  }
}

interface PopoverBodyProps {
  state: ButtonState;
  response: UpdatesResponse;
  pending: PendingInstall | null;
  /** The installation this browser followed until it failed. */
  followed: PendingInstall | null;
  /** The latest request got no answer: Logbook restarts. */
  offline: boolean;
  now: number;
  formatDateTime: (value: Date) => string;
  onInstall: (update: Update, attention: boolean) => void;
  onStopWaiting: () => void;
}

function PopoverBody({ state, response, pending, followed, offline, now, formatDateTime, onInstall, onStopWaiting }: PopoverBodyProps) {
  const status = response.updater;
  if (state === "installing") {
    const version = pending?.version ?? status?.installing?.version ?? "";
    const slow = pending ? now - pending.startedAt > INSTALL_PATIENCE_MS : false;
    const stage = offline ? "Restarting…" : status?.installing ? stageLabel(status.installing.stage, status.installed) : null;
    return (
      <div className="flex flex-col gap-1">
        <PopoverTitle>Installing {version}…</PopoverTitle>
        {stage ? <p className="text-muted-foreground">{stage}</p> : null}
        <p>Logbook restarts. This page reloads when it is back.</p>
        {slow ? (
          <>
            <p className="text-destructive">
              This takes longer than expected. Check the server (journalctl -u meldgrove-updater-&lt;project&gt;).
            </p>
            <Button size="sm" variant="outline" className="mt-2 self-start" onClick={onStopWaiting}>
              Stop waiting
            </Button>
          </>
        ) : null}
      </div>
    );
  }
  if (!status) return null;
  if (state === "failed") {
    const failed = failure(status, followed)!;
    const update = failed.update;
    const action = update ? installAction(status, update) : null;
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <PopoverTitle>Update to {failed.version} failed</PopoverTitle>
          <p className="break-words text-muted-foreground">{failed.message}</p>
          {status.installed ? <p>{status.installed} is still running.</p> : null}
        </div>
        {update && (action === "install" || action === "anyway") ? (
          <Button size="sm" className="self-start" onClick={() => onInstall(update, action === "anyway")}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  }
  if (state === "attention" && status.attention) {
    const update = status.attention;
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <PopoverTitle>{update.version} needs upgrade steps</PopoverTitle>
          <p className="text-muted-foreground">
            This release changes the setup. Take the upgrade steps from its release notes on the server first.
          </p>
        </div>
        <NotesLink update={update} />
        <InstallAction status={status} update={update} onInstall={onInstall} />
      </div>
    );
  }
  if (state === "available" && status.available) {
    const update = status.available;
    const notes = update.notes.slice(0, NOTES_SHOWN);
    const more = moreChanges(update, NOTES_SHOWN);
    const installs = installsAtText(update.installsAt, now, formatDateTime);
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <PopoverTitle>Update available</PopoverTitle>
          <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
            <span>
              {update.version}
              {update.publishedAt ? ` · ${timeAgo(update.publishedAt, now)}` : ""}
            </span>
            {update.preview ? <Badge variant="outline">Preview</Badge> : null}
          </p>
        </div>
        {notes.length > 0 ? (
          <div className="flex flex-col gap-1">
            <ul className="flex list-disc flex-col gap-1 pl-5">
              {notes.map((note, index) => (
                <li key={index} className="break-words">
                  {note}
                </li>
              ))}
            </ul>
            {more > 0 ? <p className="text-muted-foreground">and {more === 1 ? "1 more change" : `${more} more changes`}</p> : null}
          </div>
        ) : null}
        <NotesLink update={update} />
        {installs && installAction(status, update) === "install" ? <p className="text-muted-foreground">{installs}</p> : null}
        <InstallAction status={status} update={update} onInstall={onInstall} />
      </div>
    );
  }
  return null;
}

/** Install now, Install anyway…, or why the button cannot install the update. */
function InstallAction({
  status,
  update,
  onInstall,
}: {
  status: UpdaterStatus;
  update: Update;
  onInstall: (update: Update, attention: boolean) => void;
}) {
  switch (installAction(status, update)) {
    case "install":
      return (
        <Button size="sm" className="self-start" onClick={() => onInstall(update, false)}>
          Install now
        </Button>
      );
    case "anyway":
      return (
        <Button size="sm" variant="outline" className="self-start" onClick={() => onInstall(update, true)}>
          Install anyway…
        </Button>
      );
    case "locked":
      return (
        <p className="text-muted-foreground">
          The image tag set where Logbook is deployed does not reach {update.version}. Take the upgrade steps, then
          change the tag there.
        </p>
      );
    case "off":
      // The updater refuses installations while automatic updates are off.
      return (
        <p className="text-muted-foreground">
          Automatic updates are off on this server, so nothing can install. Set them up as the deployment guide describes.
        </p>
      );
  }
}

function NotesLink({ update }: { update: Update }) {
  if (!update.url) return null;
  return (
    <a
      href={update.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 self-start underline underline-offset-2 hover:text-foreground"
    >
      {update.preview ? "All changes" : "Release notes"}
      <ExternalLink aria-hidden="true" className="size-3.5" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

function PopoverFooter({
  response,
  now,
  checking,
  onCheck,
}: {
  response: UpdatesResponse;
  now: number;
  checking: boolean;
  onCheck: () => void;
}) {
  const status = response.updater;
  const installed = installedVersion(response) ?? "unknown";
  return (
    <>
      <Separator />
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>
          Installed: {installed}
          {status ? ` · ${CHANNEL_LABELS[status.channel]}` : ""}
        </p>
        {status?.error ? <p className="text-destructive">The last check failed: {status.error}</p> : null}
        <p className="flex flex-wrap items-center gap-x-2">
          <span>{status?.checkedAt ? `Checked ${timeAgo(status.checkedAt, now)}` : "Not checked yet"}</span>
          <Button variant="link" size="xs" className="h-auto px-0 text-xs" disabled={checking} onClick={onCheck}>
            {checking ? "Checking…" : "Check now"}
          </Button>
        </p>
      </div>
    </>
  );
}
