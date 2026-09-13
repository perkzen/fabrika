import { styleText } from "node:util";
import { plain, type RunEvent } from "../run-event.ts";

/** The stateful owner of one output surface. One per surface; only the console's animates. */
export type Presenter = {
  readonly show: (event: RunEvent | string) => void;
  readonly end: () => void;
};

export type ConsoleOptions = {
  readonly stream: NodeJS.WriteStream;
  readonly interactive?: boolean;
  readonly now?: () => number;
};

type Style = Parameters<typeof styleText>[0];

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const BAR = 12;

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
    case "run":
      return undefined;
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
    if (gate) lines.push(`gate ${gate.at}/${gate.of} ${gate.name}`);
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
    if (event.kind === "gate") {
      const over = event.state === "fail" || (event.at === event.of && event.state !== "start");
      gate = over ? undefined : { at: event.at, of: event.of, name: event.name };
    }
  };

  const show = (entry: RunEvent | string) => {
    if (ended) return;
    const style = typeof entry === "string" ? undefined : styleOf(entry);
    const at = stamp(now());
    const block = plain(entry)
      .map((line) => `${dress("dim", at)} ${dress(style, line)}\n`)
      .join("");
    if (!interactive) {
      stream.write(block);
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
    if (!interactive) return;
    clearLive();
    if (hidden) {
      stream.write(SHOW_CURSOR);
      hidden = false;
    }
  };

  return { show, end };
};
