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
      readonly kind: "step";
      readonly name: string;
      readonly at: number;
      readonly of: number;
      readonly state: "start" | "skipped" | "already-done";
      readonly reason?: string;
    }
  | { readonly kind: "note"; readonly level: "info" | "detail" | "warn"; readonly text: string };

/**
 * A run event as ANSI-free, unstamped text lines — one element per physical
 * line, because each surface stamps every line it writes. A bare string is
 * an info note that has already been written out.
 */
export const plain = (entry: RunEvent | string): ReadonlyArray<string> => {
  if (typeof entry === "string") return entry.split("\n");
  switch (entry.kind) {
    case "step":
      switch (entry.state) {
        case "start":
          return [`step ${entry.at}/${entry.of}: ${entry.name}`];
        case "skipped":
          return [`${entry.name}: skipped (${entry.reason})`];
        case "already-done":
          return [`${entry.name}: already done`];
      }
    case "note":
      return (entry.level === "detail" ? `  ${entry.text}` : entry.text).split("\n");
  }
};
