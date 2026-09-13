/**
 * One thing worth telling the operator about — a step beginning, a gate
 * step's verdict, something the agent said, a wait opening, the terminal
 * result. Data with a kind, never a formatted line: every event has two
 * renderings and neither of them belongs in the union.
 *
 * Imports nothing from `effect`, so the Claude wrapper and `cli.ts` can both
 * name it without reaching for a port.
 */
export type RunEvent =
  | {
      readonly kind: "run";
      readonly steps: ReadonlyArray<{ readonly name: string; readonly done: boolean }>;
      readonly completed: ReadonlyArray<string>;
    }
  | {
      readonly kind: "step";
      readonly name: string;
      readonly at: number;
      readonly of: number;
      readonly state: "start" | "skipped" | "already-done";
      readonly reason?: string;
    }
  | {
      readonly kind: "gate";
      readonly name: string;
      readonly at: number;
      readonly of: number;
      readonly command: string;
      readonly state: "start" | "pass" | "fail" | "skipped";
      readonly seconds?: number;
      readonly exitCode?: number;
    }
  | {
      readonly kind: "wait";
      readonly state: "start" | "end";
      readonly subject: string;
      readonly deadlineMinutes?: number;
      readonly seconds?: number;
    }
  | { readonly kind: "agent"; readonly stage: string; readonly markdown: string }
  | { readonly kind: "tool"; readonly stage: string; readonly tool: string; readonly subject: string }
  | { readonly kind: "cost"; readonly stage: string; readonly usd: number }
  | { readonly kind: "note"; readonly level: "info" | "detail" | "warn"; readonly text: string }
  | { readonly kind: "result"; readonly outcome: "done" | "escalated"; readonly text: string };

/** How long something took, read the way an operator says it: `12s`, `4m 12s`. */
export const elapsed = (seconds: number): string => {
  const whole = Math.max(Math.floor(seconds), 0);
  return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`;
};

/** When something happened, as the surface writing it says: `14:03:09`, local, 24-hour. */
export const stamp = (at: number): string => new Date(at).toLocaleTimeString("en-GB", { hour12: false });

/**
 * Every control character but tab and newline, gone.
 *
 * An event's text is not the run's own words: it carries what the agent said,
 * what a tool was called with, what `gh` handed back — all of it derived from
 * repo files, review threads and fetched pages. A terminal obeys what it is
 * sent, so an escape sequence in any of that can clear the screen over a
 * failed gate, retitle the window, or write the operator's clipboard, and a
 * carriage return can overwrite a line to forge the `done:` one.
 *
 * The escape byte alone is dropped rather than the whole sequence: `[2J`
 * stays on screen as the defanged text it is, which is more honest than a
 * matcher that has to be right about every sequence there is.
 */
export const scrub = (text: string): string => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

/**
 * A run event as ANSI-free, unstamped text lines — one element per physical
 * line, because each surface stamps every line it writes. A bare string is
 * an info note that has already been written out.
 *
 * Scrubbed on the way out, at the one point every surface's every line
 * passes through. The console's agent branch is the sole line that does not
 * come through here, and it scrubs before it lexes.
 */
export const plain = (entry: RunEvent | string): ReadonlyArray<string> => render(entry).map(scrub);

const render = (entry: RunEvent | string): ReadonlyArray<string> => {
  if (typeof entry === "string") return entry.split("\n");
  switch (entry.kind) {
    // The ticket header is preflight's line and stays preflight's line; this
    // event says what the run is made of and how much of it is already behind.
    case "run":
      return [
        ...(entry.completed.length > 0 ? [`resuming after ${entry.completed.join(", ")}`] : []),
        `steps: ${entry.steps.map((step) => step.name).join(", ")}`,
      ];
    case "step":
      switch (entry.state) {
        case "start":
          return [`step ${entry.at}/${entry.of}: ${entry.name}`];
        case "skipped":
          return [`${entry.name}: skipped (${entry.reason})`];
        case "already-done":
          return [`${entry.name}: already done`];
      }
    case "gate":
      switch (entry.state) {
        case "start":
          return [`gate ${entry.name}: ${entry.command}`];
        case "pass":
          return [`gate ${entry.name}: ok (${entry.seconds}s)`];
        case "fail":
          return [`gate ${entry.name}: FAILED (exit ${entry.exitCode}, ${entry.seconds}s)`];
        // The only skip reason shell-gate has; a second one earns a field.
        case "skipped":
          return [`gate ${entry.name}: skipped (no matching changes)`];
      }
    // The start line is what the poll loops wrote once a poll; the end line
    // is new, and is strictly more than the repetition it replaces.
    case "wait":
      return entry.state === "start"
        ? [`waiting for ${entry.subject}`]
        : [`waited ${elapsed(entry.seconds ?? 0)} for ${entry.subject}`];
    // The archive gets the markdown as it was written: `- item` renders
    // where `• item` does not, and a run is pasted into issues. The console
    // is the one surface that walks it, and it does so without coming here.
    case "agent":
      return entry.markdown.split("\n");
    case "tool":
      return [`  ${entry.tool}${entry.subject ? ` ${entry.subject}` : ""}`];
    case "cost":
      return [`  (${entry.stage}: $${entry.usd.toFixed(2)})`];
    case "note":
      return (entry.level === "detail" ? `  ${entry.text}` : entry.text).split("\n");
    // Already written out by whoever decided the run was over: the wording of
    // the `done:` line is the piped contract and nothing here may reshape it.
    case "result":
      return [entry.text];
  }
};
