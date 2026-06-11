/**
 * Parent-PID watcher.
 *
 * On Unix, when a parent process dies the OS reparents the child to init
 * (PID 1) or launchd. Polling `process.ppid` catches this within `pollMs`
 * milliseconds and lets us exit cleanly so we don't leak orphan proxies.
 *
 * Returns a stop() function that cancels the watcher. Pure: all side effects
 * are injected (readPpid + onParentDied + the timer is testable via fake timers).
 */

export type ParentPidWatcherInput = {
  initialPpid: number;
  readPpid: () => number;
  pollMs: number;
  onParentDied: (info: { initialPpid: number; currentPpid: number }) => void;
};

export function startParentPidWatcher(
  input: ParentPidWatcherInput,
): () => void {
  const { initialPpid, readPpid, pollMs, onParentDied } = input;
  const timer = setInterval(() => {
    const current = readPpid();
    if (current !== initialPpid) {
      clearInterval(timer);
      onParentDied({ initialPpid, currentPpid: current });
    }
  }, pollMs);
  // Don't keep the event loop alive just for this poller.
  if (typeof (timer as NodeJS.Timer).unref === "function") {
    (timer as NodeJS.Timer).unref();
  }
  return () => clearInterval(timer);
}
