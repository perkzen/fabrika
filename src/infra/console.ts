import { styleText } from "node:util";
import { renderMarkdown } from "./markdown.ts";
import { elapsed, plain, type RunEvent } from "../run-event.ts";

/** The stateful owner of one output surface. One per surface; only the console's animates. */
export type Presenter = {
  readonly show: (event: RunEvent | string) => void;
  readonly end: () => void;
};

export type ConsoleOptions = {
  readonly stream: NodeJS.WriteStream;
  readonly interactive?: boolean;
  readonly now?: () => number;
  /** Where the uncapped copy lives, named in the elision line. `init` has none. */
  readonly archive?: string;
};

type Style = Parameters<typeof styleText>[0];

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const BAR = 12;
/** The conventional braille cadence; one array literal is cheaper than a dependency. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const FRAME_MS = 80;
/** What the poll loops printed per poll. A pipe needs the proof of life; a file does not. */
const HEARTBEAT_MS = 60_000;
/** About two-thirds of a small terminal: a plan's headings arrive whole, one message still cannot own the screen. */
const MESSAGE_LINES = 20;
/** Marks the agent's own lines, so its speech is never mistaken for the run's. */
const GUTTER = "│ ";

const stamp = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour12: false });

/**
 * A run is either fully dressed or fully plain, never partly: one verdict out
 * of all four inputs, so a `NO_COLOR` run and a piped run look the same.
 */
const isInteractive = (stream: NodeJS.WriteStream) =>
  Boolean(stream.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb" && !process.env.CI;

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
 * A presenter over a stream. Dependencies are handed in rather than reached
 * for, so a test can drive a scripted run into an in-memory sink and `init`
 * can build one with no run directory behind it.
 *
 * Interactively, permanent lines are written as clear-write-redraw in one
 * synchronous pass, so their order against the live region holds without any
 * coordination — which is what keeps the piped contract true.
 */
export const openConsole = (options: ConsoleOptions): Presenter => {
  const stream = options.stream;
  const now = options.now ?? Date.now;
  const interactive = options.interactive ?? isInteractive(stream);

  /** How many rows the live region currently occupies. Exactly one per line, because every line is cut. */
  let drawn = 0;
  let hidden = false;
  let ended = false;
  let progress: { at: number; of: number; name: string } | undefined;
  let gate: { at: number; of: number; name: string } | undefined;
  let wait: { subject: string; since: number; deadlineMinutes?: number } | undefined;
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;
  let frame = 0;

  const dress = (style: Style | undefined, text: string) =>
    interactive && style ? styleText(style, text, { validateStream: false }) : text;

  /** A non-TTY sink reports no width; 80 is the only sane guess. Read per draw, so a resize needs no listener. */
  const width = () => (typeof stream.columns === "number" && stream.columns > 1 ? stream.columns : 80);

  /**
   * Cut before styling, never after: truncating a styled line mid-escape
   * corrupts it, and a line of exactly `columns - 1` occupies exactly one row,
   * which is what makes the cursor arithmetic below correct.
   */
  const cut = (line: string) => line.slice(0, width() - 1);

  const liveLines = (): ReadonlyArray<string> => {
    const lines: Array<string> = [];
    if (progress) {
      const filled = Math.round((Math.max(progress.at - 1, 0) / Math.max(progress.of, 1)) * BAR);
      const bar = "█".repeat(filled) + "░".repeat(BAR - filled);
      lines.push(`[${bar}] ${progress.at}/${progress.of} ${progress.name}`);
    }
    // A gate is a synchronous shell run and a wait is not, so the two can
    // never both be open; the second line belongs to whichever one is.
    if (wait) {
      const against = wait.deadlineMinutes ? ` / ${wait.deadlineMinutes}m` : "";
      lines.push(`${FRAMES[frame % FRAMES.length]} waiting for ${wait.subject} — ${elapsed((now() - wait.since) / 1000)}${against}`);
    } else if (gate) {
      lines.push(`gate ${gate.at}/${gate.of} ${gate.name}`);
    }
    return lines;
  };

  const clearLive = () => {
    if (drawn === 0) return;
    stream.write(`\x1b[${drawn}A\x1b[0J`);
    drawn = 0;
  };

  const drawLive = () => {
    const lines = liveLines();
    if (lines.length === 0) return;
    if (!hidden) {
      stream.write(HIDE_CURSOR);
      hidden = true;
    }
    stream.write(lines.map((line) => dress("dim", cut(line)) + "\n").join(""));
    drawn = lines.length;
  };

  /** What the live region shows next. A gate leaves it when it fails or when its last step is behind it. */
  const track = (event: RunEvent) => {
    if (event.kind === "run") progress = { at: 0, of: event.steps.length, name: "" };
    if (event.kind === "step") progress = { at: event.at, of: event.of, name: event.name };
    if (event.kind === "wait") {
      if (event.state === "start") {
        wait = { subject: event.subject, since: now(), deadlineMinutes: event.deadlineMinutes };
        frame = 0;
        arm();
      } else {
        wait = undefined;
        disarm();
      }
    }
    if (event.kind === "gate") {
      const over = event.state === "fail" || (event.at === event.of && event.state !== "start");
      gate = over ? undefined : { at: event.at, of: event.of, name: event.name };
    }
  };

  /**
   * The animation tick belongs here and to nothing that emits, which is what
   * keeps `write` synchronous and a wait two events rather than a stream.
   * A live timer holds the event loop open, so it is armed only while a wait
   * is, and `unref` is the belt to `disarm`'s braces.
   */
  const arm = () => {
    disarm();
    timer = globalThis.setInterval(
      interactive
        ? () => {
            frame += 1;
            clearLive();
            drawLive();
          }
        : () => {
            // Through `plain()`, not a template literal that says the same
            // thing: the heartbeat is a repetition of the `start` line, and
            // the piped rendering of a wait gets to have one definition.
            if (wait) for (const line of plain({ kind: "wait", state: "start", subject: wait.subject })) stream.write(`${stamp(now())} ${line}\n`);
          },
      interactive ? FRAME_MS : HEARTBEAT_MS,
    );
    timer.unref?.();
  };

  const disarm = () => {
    if (timer === undefined) return;
    globalThis.clearInterval(timer);
    timer = undefined;
  };

  /**
   * The one kind a console does not render through `plain()`. `plain()` is
   * the archive's rendering and keeps the markdown raw; the console walks it
   * and caps its height, in both modes, because `2>&1 | tee` is the common
   * case and a capped message has to read the same either way.
   */
  const lines = (entry: RunEvent | string): ReadonlyArray<string> => {
    if (typeof entry === "string" || entry.kind !== "agent") return plain(entry);
    const walked = renderMarkdown(entry.markdown, dress);
    const missing = walked.length - MESSAGE_LINES;
    const block =
      missing <= 0
        ? walked
        : [...walked.slice(0, MESSAGE_LINES), dress("dim", `… ${missing} more lines${options.archive ? ` (${options.archive})` : ""}`)];
    // The gutter is what tells the operator, at a glance, which lines are the
    // agent's; it marks the whole block, elision line included.
    return block.map((line) => dress("dim", GUTTER) + line);
  };

  const show = (entry: RunEvent | string) => {
    if (ended) return;
    const style = typeof entry === "string" ? undefined : styleOf(entry);
    const at = stamp(now());
    const block = lines(entry)
      .map((line) => `${dress("dim", at)} ${dress(style, line)}\n`)
      .join("");
    if (!interactive) {
      stream.write(block);
      if (typeof entry !== "string") track(entry);
      return;
    }
    clearLive();
    if (block) stream.write(block);
    if (typeof entry !== "string") track(entry);
    drawLive();
  };

  const end = () => {
    if (ended) return;
    ended = true;
    disarm();
    if (!interactive) return;
    process.off("SIGINT", end);
    clearLive();
    if (hidden) {
      stream.write(SHOW_CURSOR);
      hidden = false;
    }
  };

  // `console.log` swallowed write errors; a raw `stream.write` does not, and
  // an unhandled `error` event would take the run down under `| head`.
  stream.on("error", () => {});
  // Only when there is a terminal to restore, and it calls nothing but the
  // idempotent `end()`: `runMain` already interrupts the fiber on SIGINT, and
  // a `process.exit` here would preempt the finalisers that clean up the MCP
  // temp files. This covers the case where that interruption stalls.
  if (interactive) process.on("SIGINT", end);

  return { show, end };
};
