import { styleText } from "node:util";
import { display, livenessRow, progressRow } from "./lines.ts";
import type { Tree } from "../outline.ts";
import { gateOver, plain, scrub, stamp, type RunEvent } from "../run-event.ts";

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
  /**
   * The run's worktree, absolute. An option rather than a run event: `log.txt`
   * gets every event, and where this machine put the tree is no business of
   * the record. A surface given none says nothing about one.
   */
  readonly worktree?: string;
};

/** The shape `styleText` takes, named once so every surface that dresses a line reads the same alias. */
export type Style = Parameters<typeof styleText>[0];

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const FRAME_MS = 80;
/** What the poll loops printed per poll. A pipe needs the proof of life; a file does not. */
const HEARTBEAT_MS = 60_000;
/** About two-thirds of a small terminal: a plan's headings arrive whole, one message still cannot own the screen. */
const MESSAGE_LINES = 20;

/**
 * A run is either fully dressed or fully plain, never partly: one verdict out
 * of all four inputs, so a `NO_COLOR` run and a piped run look the same.
 */
export const isInteractive = (stream: NodeJS.WriteStream) =>
  Boolean(stream.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb" && !process.env.CI;

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
  /**
   * Armed by the `run` event, the way `openNotifier` is: a rerun that
   * short-circuits before the pipeline emits one has no tree worth naming,
   * and neither has the inner console a screen leaves behind on mount.
   */
  let started = false;
  /** Whether the worktree has been named already. A run says where its tree is once. */
  let wrote = false;
  /**
   * The three scalars the live region needs, read straight off the events
   * that carry them. This surface never shows the run's shape, so it holds no
   * step tree: the rows it draws are the screen's, and only those.
   */
  let progress: { at: number; of: number; name: string } | undefined;
  let live: Pick<Tree, "wait" | "gate"> = {};
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;
  let spin = 0;

  const dress = (style: Style | undefined, text: string) =>
    interactive && style ? styleText(style, text, { validateStream: false }) : text;

  /** A non-TTY sink reports no width; 80 is the only sane guess. Read per draw, so a resize needs no listener. */
  const width = () => (typeof stream.columns === "number" && stream.columns > 1 ? stream.columns : 80);

  /**
   * Cut before styling, never after: truncating a styled line mid-escape
   * corrupts it, and a line of exactly `columns - 1` occupies exactly one row,
   * which is what makes the cursor arithmetic below correct. Scrubbed for the
   * same reason: one escape in a subject and a row is no longer a row.
   */
  const cut = (line: string) => scrub(line).slice(0, width() - 1);

  const liveLines = (): ReadonlyArray<string> => {
    const blocked = livenessRow(live, { now: now(), spin });
    // Either line can stand without the other: a wait can open before the
    // first step, and most of a run is a progress line with nothing under it.
    return [...(progress ? [progressRow(progress)] : []), ...(blocked === undefined ? [] : [blocked])];
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

  /** What the live region shows next. */
  const track = (event: RunEvent) => {
    if (event.kind === "run") progress = { at: 0, of: event.steps.length, name: "" };
    if (event.kind === "step") progress = { at: event.at, of: event.of, name: event.name };
    if (event.kind === "wait") {
      if (event.state === "start") {
        live = { ...live, wait: { subject: event.subject, since: now(), deadlineMinutes: event.deadlineMinutes } };
        spin = 0;
        arm();
      } else {
        live = { ...live, wait: undefined };
        disarm();
      }
    }
    if (event.kind === "gate") {
      live = {
        ...live,
        gate: gateOver(event) ? undefined : { name: event.name, at: event.at, of: event.of, command: event.command },
      };
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
            spin += 1;
            clearLive();
            drawLive();
          }
        : () => {
            // Through `plain()`, not a template literal that says the same
            // thing: the heartbeat is a repetition of the `start` line, and
            // the piped rendering of a wait gets to have one definition.
            if (live.wait) for (const line of plain({ kind: "wait", state: "start", subject: live.wait.subject })) stream.write(`${stamp(now())} ${line}\n`);
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
   * Where the run's tree is, written once and back through `show`, so it is
   * stamped, dressed and ordered against the live region by the same
   * clear-write-redraw pass as every other permanent line — on a terminal and
   * through a pipe alike, with no second rendering path.
   */
  const worktreeLine = () => {
    if (!started || wrote || options.worktree === undefined) return;
    // Before `show`, which is about to call back in here: the flag is what
    // makes the line exactly one.
    wrote = true;
    show(`worktree: ${options.worktree}`);
  };

  const show = (entry: RunEvent | string) => {
    if (ended) return;
    if (typeof entry !== "string") {
      if (entry.kind === "run") started = true;
      // Above the result and never below it: the piped contract is that a
      // clean run's last stdout line is the pull request's URL.
      if (entry.kind === "result") worktreeLine();
    }
    const at = stamp(now());
    const block = display(entry, dress, { cap: MESSAGE_LINES, archive: options.archive })
      .map((line) => `${dress("dim", at)} ${line}\n`)
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
    // Before `ended`, which `show` early-returns on, and before the pipe's
    // return below: a run that stopped without a verdict — a Ctrl-C, a usage
    // limit, a crash — is the one that most needs to say where its tree is.
    worktreeLine();
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
