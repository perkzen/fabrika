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
  | { readonly kind: "note"; readonly level: "info" | "detail" | "warn"; readonly text: string }
  | { readonly kind: "result"; readonly outcome: "done" | "escalated"; readonly text: string };

/**
 * A run event as ANSI-free, unstamped text lines — one element per physical
 * line, because each surface stamps every line it writes. A bare string is
 * an info note that has already been written out.
 */
export const plain = (entry: RunEvent | string): ReadonlyArray<string> => {
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
    case "note":
      return (entry.level === "detail" ? `  ${entry.text}` : entry.text).split("\n");
    // Already written out by whoever decided the run was over: the wording of
    // the `done:` line is the piped contract and nothing here may reshape it.
    case "result":
      return [entry.text];
  }
};
