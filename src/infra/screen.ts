import { styleText } from "node:util";
import { frame, rows, type View } from "./frame.ts";
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
  const inner = openConsole(options);

  let tree: Tree = { ...empty, label: options.ticket };
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
    const lines = frame(tree, view, size(), dress, { now: now(), spin });
    stream.write(HOME + lines.map((line) => line + CLEAR_LINE).join("\n") + CLEAR_BELOW);
    dirty = false;
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
    process.on("SIGINT", end);
    timer = globalThis.setInterval(() => {
      spin += 1;
      if (dirty) draw();
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
      return mount();
    }
    tree = take(tree, at, entry);
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
    process.off("SIGINT", end);
    stream.write(ALTERNATE_OFF + SHOW_CURSOR);
    for (const line of rows(tree, size().columns, dress)) stream.write(line + "\n");
    if (tree.result) stream.write(dress(["bold", tree.result.outcome === "done" ? "green" : "red"], tree.result.text) + "\n");
  };

  return { show, end };
};
