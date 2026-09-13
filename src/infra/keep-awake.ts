import { spawn } from "node:child_process";
import type { RunEvent } from "../run-event.ts";

/**
 * Holds the machine awake for as long as this process lives.
 *
 * A run is mostly waiting on things the host does not control — an agent call,
 * the reviewer, the PR's checks — and a laptop that suspends during one takes
 * every open wait down with it. The operator's own workaround was a second
 * terminal running `caffeinate -w` against the Claude app; this is the same
 * assertion, made by the process that actually has the run.
 *
 * `-w` takes fabrika's own pid, which is why there is nothing here to release:
 * caffeinate exits when fabrika exits, however it goes out. That is not a
 * convenience — `cli.ts` leaves through `process.exit` on an escalation and on
 * a usage limit, and neither runs an Effect finalizer, so an assertion held by
 * a scope would leak on exactly the runs that take longest.
 *
 * `-i` and `-s` are the two that keep a headless run alive (idle sleep, system
 * sleep on AC); `-d` and `-u` keep the display lit and declare user activity,
 * so the screen does not lock over a run the operator is watching.
 *
 * macOS only, and never fatal: `caffeinate` is a Darwin binary, and a machine
 * that falls asleep is a nuisance, not a wrong result. A missing binary
 * arrives asynchronously as an `error` event — unhandled, that is an uncaught
 * exception that would kill the run this exists to protect.
 */
export const keepAwake = (write: (entry: RunEvent | string) => void): void => {
  if (process.platform !== "darwin") {
    write({ kind: "note", level: "warn", text: "keepAwake is set, but only macOS is supported — the machine may sleep mid-run" });
    return;
  }
  const child = spawn("caffeinate", ["-dimsu", "-w", String(process.pid)], { stdio: "ignore" });
  // Both notes wait for the outcome: the assertion is not held until the
  // process is actually up, and saying so before that is a claim the operator
  // would then watch being taken back a line later.
  child.on("spawn", () => write({ kind: "note", level: "detail", text: "holding the machine awake until this run exits" }));
  child.on("error", (e) =>
    write({ kind: "note", level: "warn", text: `could not hold the machine awake (${e.message}) — the run continues` }),
  );
  // So the assertion never keeps the event loop, and so the run ends when the
  // pipeline ends rather than when caffeinate notices that it has.
  child.unref();
};
