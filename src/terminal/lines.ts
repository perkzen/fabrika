import { renderMarkdown, type Styler } from "./markdown.ts";
import type { Style } from "./console.ts";
import type { Tree } from "../domain/outline.ts";
import { elapsed, plain, scrub, type RunEvent } from "../domain/run-event.ts";

/** Marks the agent's own lines, so its speech is never mistaken for the run's. */
const GUTTER = "│ ";

export type DisplayOptions = {
  /**
   * The tallest an agent message may be. Scrollback caps, because one message
   * must not own the screen; a window does not, because it is scrolled.
   */
  readonly cap?: number;
  /** Where the uncapped copy lives, named in the elision line. */
  readonly archive?: string;
};

/**
 * One run event as the dressed lines a reader sees — the colour table, the
 * gutter on agent speech, the markdown walk, and the height cap if the
 * surface asks for one. Unstamped: the timestamp belongs to whoever writes
 * the line, because a window and the scrollback under it write it differently.
 *
 * The one definition of a line, so the screen and the scrollback console
 * cannot drift. `plain()` is still the archive's rendering and keeps the
 * markdown raw; this is every surface that has a reader in front of it.
 */
export const display = (entry: RunEvent | string, dress: Styler, options: DisplayOptions = {}): ReadonlyArray<string> => {
  if (typeof entry !== "string" && entry.kind === "agent") return speech(entry.markdown, dress, options);
  const style = typeof entry === "string" ? undefined : styleOf(entry);
  return plain(entry).map((line) => (style ? dress(style, line) : line));
};

/**
 * The one kind that is not rendered through `plain()`: the console walks the
 * markdown itself, because `2>&1 | tee` is the common case and a walked
 * message has to read the same either way.
 */
const speech = (markdown: string, dress: Styler, options: DisplayOptions): ReadonlyArray<string> => {
  // Scrubbed before the lexer, never after the walk: after it, the styling
  // added here would be scrubbed along with the agent's.
  const walked = renderMarkdown(scrub(markdown), dress);
  const missing = options.cap === undefined ? 0 : walked.length - options.cap;
  const block =
    missing <= 0
      ? walked
      : [...walked.slice(0, options.cap), dress("dim", `… ${missing} more lines${options.archive ? ` (${options.archive})` : ""}`)];
  // The gutter is what tells the operator, at a glance, which lines are the
  // agent's; it marks the whole block, elision line included.
  return block.map((line) => dress("dim", GUTTER) + line);
};

/** The colour a kind is read in. Anything not named here is the terminal's own default. */
const styleOf = (event: RunEvent): Style | undefined => {
  switch (event.kind) {
    case "step":
      return "bold";
    case "gate":
      return event.state === "pass" ? "green" : event.state === "fail" ? ["bold", "red"] : event.state === "skipped" ? "dim" : undefined;
    case "note":
      return event.level === "warn" ? "yellow" : event.level === "detail" ? "dim" : undefined;
    case "result":
      return event.outcome === "done" ? ["bold", "green"] : ["bold", "red"];
    // The lines a run emits most of, several per agent message: they have to
    // recede behind the step they belong to, not compete with it.
    case "tool":
    case "cost":
      return "dim";
    case "run":
    case "wait":
    case "agent":
      return undefined;
    // `plain()` cannot fall behind the union — it returns a non-optional type,
    // so a missing case is a compile error there. `Style | undefined` makes
    // the same omission legal here, and this is what takes that back.
    default:
      return event satisfies never;
  }
};

/**
 * The conventional braille cadence; one array literal is cheaper than a
 * dependency. Private, so every surface that spins does it by calling
 * `spinner` rather than by reaching for the same constant.
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
/** How wide the run's progress bar is drawn, on either surface. */
const BAR = 12;

/** `now` and `spin` are arguments rather than reads, so an elapsed time is a fact a test states. */
export type Clock = { readonly now: number; readonly spin: number };

/**
 * The frame the run is on: one glyph, one column wide, the same cadence
 * wherever something is turning.
 *
 * Exported rather than the frame list, so the liveness row's spinner and the
 * running step's marker cannot fall out of step with each other.
 */
export const spinner = (clock: Clock): string => FRAMES[clock.spin % FRAMES.length]!;

/**
 * How far through the run is: the bar, the position, and the step it is on.
 *
 * The scrollback console's first live line and the screen's header are the
 * same row — the console writes it at the bottom of scrollback and the screen
 * writes it at the top of the viewport, and neither gets its own arithmetic.
 */
export const progressRow = (progress: { readonly at: number; readonly of: number; readonly name: string }): string => {
  const filled = Math.round((Math.max(progress.at - 1, 0) / Math.max(progress.of, 1)) * BAR);
  const bar = "█".repeat(filled) + "░".repeat(BAR - filled);
  return `[${bar}] ${progress.at}/${progress.of}${progress.name ? ` ${progress.name}` : ""}`;
};

/**
 * What the run is blocked on, or nothing when it is blocked on nothing: an
 * open wait's spinner, elapsed time and deadline, or the gate step running now.
 *
 * A gate is a synchronous shell run and a wait is not, so the two can never
 * both be open; the row belongs to whichever one is. The screen appends the
 * gate's command, because a window is where the gate's own line is and the
 * scrollback already has it above.
 */
export const livenessRow = (live: Pick<Tree, "wait" | "gate">, clock: Clock): string | undefined => {
  if (live.wait) {
    const against = live.wait.deadlineMinutes ? ` / ${live.wait.deadlineMinutes}m` : "";
    return `${spinner(clock)} waiting for ${live.wait.subject} — ${elapsed((clock.now - live.wait.since) / 1000)}${against}`;
  }
  if (live.gate) return `gate ${live.gate.at}/${live.gate.of} ${live.gate.name}`;
  return undefined;
};
