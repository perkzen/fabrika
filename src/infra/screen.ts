import { homedir } from "node:os";
import { styleText } from "node:util";
import { frame, outlineRows, type View } from "./frame.ts";
import { display } from "./lines.ts";
import { decode, follow, press } from "./keys.ts";
import { isInteractive, openConsole, type ConsoleOptions, type Presenter, type Style } from "./console.ts";
import type { Styler } from "./markdown.ts";
import { empty, take, type Tree } from "../outline.ts";
import type { RunEvent } from "../run-event.ts";

export type ScreenOptions = ConsoleOptions & {
  /** What the header calls this run. No run event carries it; see `Tree.label`. */
  readonly ticket?: string;
  /** Where keys come from. Taken only when it is a TTY that can be put in raw mode. */
  readonly input?: NodeJS.ReadStream;
  /** How `Ctrl-C` is raised, injected so a test can press it without signalling the test runner. */
  readonly kill?: () => void;
  /**
   * What `o` does — already bound to the worktree, and injected so a test
   * presses it without spawning anything. Its presence is also what decides
   * whether the keys row names the key at all.
   */
  readonly open?: () => void;
};

const ALTERNATE_ON = "\x1b[?1049h";
const ALTERNATE_OFF = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const HOME = "\x1b[H";
const CLEAR_LINE = "\x1b[K";
const CLEAR_BELOW = "\x1b[0J";
const FRAME_MS = 80;
/** A terminal that reports no size: the same guesses the scrollback console makes, one for each axis. */
const COLUMNS = 80;
const ROWS = 24;

/**
 * The presenter that owns the terminal's alternate buffer for the length of a
 * run: the outline drawn into it, the running step unfolded under its line.
 *
 * The same two-method interface every surface has, so `file-journal.ts` fans
 * out to it with no idea which one it got. Before the first `run` event it
 * forwards to an inner scrollback console, so the banner, the auth probe's
 * notes and the `already done:` line stay where an operator can scroll to
 * them — a screen is entered by a run that has steps, and by nothing else.
 */
export const openScreen = (options: ScreenOptions): Presenter => {
  const stream = options.stream;
  const now = options.now ?? Date.now;
  const interactive = options.interactive ?? isInteractive(stream);
  // Also what swallows a write error on this stream — a run under `| head` must
  // not die of `EPIPE` — because the inner console attaches that handler and
  // never takes it off.
  const inner = openConsole(options);
  const kill = options.kill ?? (() => process.kill(process.pid, "SIGINT"));
  // Only a TTY that can be put in raw mode: a TTY stdout with a piped stdin
  // gets the screen and no keys, because a run nobody can touch already has
  // to end the same way.
  const keyboard =
    options.input?.isTTY && typeof options.input.setRawMode === "function" ? options.input : undefined;

  let tree: Tree = { ...empty, label: options.ticket, worktree: options.worktree };
  // Once per run rather than per draw: it cannot change while one is going,
  // and a frame is drawn twelve times a second. Read here because `frame` is
  // pure and has no machine in it.
  // The opener's presence is the single fact deciding both whether `o` does
  // anything and whether the keys row names it, so the two cannot disagree.
  const operator = { home: homedir(), editor: options.open !== undefined };
  let view: View = { selected: "", opened: null, chosen: false, scroll: 0, top: 0 };
  let mounted = false;
  let ended = false;
  let dirty = false;
  let spin = 0;
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;

  const dress: Styler = (style: Style, text: string) =>
    interactive ? styleText(style, text, { validateStream: false }) : text;

  /** Read per draw, both axes, so a resize needs no listener for the size itself. */
  const size = () => ({
    columns: typeof stream.columns === "number" && stream.columns > 1 ? stream.columns : COLUMNS,
    rows: typeof stream.rows === "number" && stream.rows > 0 ? stream.rows : ROWS,
  });

  /**
   * A home and a write. Each row is followed by an erase-to-end-of-line and
   * the last one carries no newline: one would scroll the alternate buffer by
   * a row and put every frame after it permanently out.
   */
  const draw = () => {
    const lines = frame(tree, view, size(), dress, { now: now(), spin }, operator);
    stream.write(HOME + lines.map((line) => line + CLEAR_LINE).join("\n") + CLEAR_BELOW);
    dirty = false;
  };

  // Only the redraw: the size itself is read per draw, above.
  const onResize = () => void (dirty = true);

  const onKey = (chunk: string) => {
    for (const key of decode(String(chunk))) {
      // Not `press`'s business: raw mode stops the terminal raising SIGINT, so
      // this does, and `runMain` interrupts the fiber. A `process.exit` here
      // would preempt the finalisers that clean up the MCP temp files.
      if (key === "interrupt") kill();
      // Not `press`'s business either: it is pure and returns a view, and an
      // editor is not a view.
      else if (key === "open") options.open?.();
      else view = press(key, view, tree, size());
    }
    dirty = true;
  };

  /**
   * The inner console goes first: it clears its live region, restores the
   * cursor and takes its own SIGINT handler off, all of which belong to the
   * primary buffer it is leaving behind.
   */
  const mount = () => {
    inner.end();
    stream.write(ALTERNATE_ON + HIDE_CURSOR);
    mounted = true;
    if (keyboard) {
      keyboard.setRawMode(true);
      keyboard.resume();
      keyboard.setEncoding("utf8");
      keyboard.on("data", onKey);
    }
    process.on("SIGINT", end);
    stream.on("resize", onResize);
    // A frame is a whole viewport, so it is drawn only when there is something
    // to see: the step tree changed, or a wait is open and its spinner is the
    // proof the run is alive.
    timer = globalThis.setInterval(() => {
      spin += 1;
      if (dirty || tree.wait) draw();
    }, FRAME_MS);
    timer.unref?.();
    draw();
  };

  const show = (entry: RunEvent | string) => {
    if (ended) return;
    const at = now();
    if (!mounted) {
      if (typeof entry === "string" || entry.kind !== "run") return inner.show(entry);
      tree = take(tree, at, entry);
      view = follow(view, tree);
      return mount();
    }
    tree = take(tree, at, entry);
    view = follow(view, tree);
    dirty = true;
  };

  const end = () => {
    if (ended) return;
    ended = true;
    if (timer !== undefined) globalThis.clearInterval(timer);
    timer = undefined;
    // Nothing was entered, so there is nothing to leave: the `already done:`
    // short-circuit emits no run event and gets the inner console's end alone.
    if (!mounted) return inner.end();
    if (keyboard) {
      keyboard.off("data", onKey);
      keyboard.setRawMode(false);
      keyboard.pause();
      // Raw mode holds the event loop open; releasing it is the exact inverse
      // plus this, so a clean run can exit.
      keyboard.unref?.();
    }
    process.off("SIGINT", end);
    stream.off("resize", onResize);
    stream.write(ALTERNATE_OFF + SHOW_CURSOR);
    for (const line of outlineRows(tree, size().columns, dress)) stream.write(line + "\n");
    // Absolute and unabbreviated: this is the line an operator copies into a
    // `cd`, an hour after the screen it was a `~` on has gone.
    if (tree.worktree) for (const line of display(`worktree: ${tree.worktree}`, dress)) stream.write(line + "\n");
    // Through `display`, like every other line this repo writes: it is where
    // the result's colour is decided and, more to the point, where the text is
    // scrubbed. An escalation's wording carries `gh` output and agent text,
    // and this is the line the operator reads the outcome off.
    if (tree.result) for (const line of display(tree.result, dress)) stream.write(line + "\n");
  };

  return { show, end };
};
