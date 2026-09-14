import { homedir } from "node:os";
import { frame, outlineRows, type View } from "./frame.ts";
import { display } from "./lines.ts";
import { decode, follow, press } from "./keys.ts";
import { openConsole, type ConsoleOptions } from "./console.ts";
import {
  ALTERNATE_OFF,
  ALTERNATE_ON,
  CLEAR_BELOW,
  CLEAR_LINE,
  HIDE_CURSOR,
  HOME,
  isInteractive,
  SHOW_CURSOR,
  sizeOf,
  styler,
  type Presenter,
} from "./surface.ts";
import { bound, empty, steps, take, waiting, type Tree } from "../domain/outline.ts";
import type { RunEvent } from "../domain/run-event.ts";

export type ScreenOptions = ConsoleOptions & {
  /** What the header calls this run. No run event carries it; see `Tree.label`. */
  readonly ticket?: string;
  /** Where keys come from. Taken only when it is a TTY that can be put in raw mode. */
  readonly input?: NodeJS.ReadStream;
  /** How `Ctrl-C` is raised, injected so a test can press it without signalling the test runner. */
  readonly kill?: () => void;
  /**
   * What `o` does, given the tree to open — injected so a test presses it
   * without spawning anything. Its presence is also what decides whether the
   * keys row names the key at all; which tree it is handed is the selected
   * row's, because a sweep has one per row and only the run has one for the
   * whole screen.
   */
  readonly open?: (worktree: string) => void;
};

/**
 * A screen, and the presenters it hands out for the rows on it.
 *
 * `row` is what a sweep's composition root gives each worker's journal
 * alongside its archive: everything shown through it lands under that row and
 * under no other. It exists because "the one child whose state is `running`"
 * is right for a run and wrong for five workers out of six.
 */
export type Screen = Presenter & {
  readonly row: (name: string, worktree?: string) => Presenter;
};

const FRAME_MS = 80;

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
export const openScreen = (options: ScreenOptions): Screen => {
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
  // Read here because `frame` is pure and has no machine in it, and once per
  // run rather than per draw: neither fact can change while one is going, and
  // a frame is drawn twelve times a second.
  const operator = { home: homedir(), editor: options.open !== undefined };
  let view: View = { selected: "", opened: null, chosen: false, scroll: 0, top: 0 };
  let mounted = false;
  let ended = false;
  let dirty = false;
  let spin = 0;
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;

  const dress = styler(interactive);

  /** Read per draw, both axes, so a resize needs no listener for the size itself. */
  const size = () => sizeOf(stream);

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

  /** A row with no tree opens nothing: an editor on nowhere is worse than a key that did not fire. */
  const opened = (worktree: string | undefined) => {
    if (worktree !== undefined) options.open?.(worktree);
  };

  const onKey = (chunk: string) => {
    for (const key of decode(String(chunk))) {
      // Not `press`'s business: raw mode stops the terminal raising SIGINT, so
      // this does, and `runMain` interrupts the fiber. A `process.exit` here
      // would preempt the finalisers that clean up the MCP temp files.
      if (key === "interrupt") kill();
      // Not `press`'s business either: it is pure and returns a view, and an
      // editor is not a view. The selected row's tree before the run's: a
      // sweep's trees are one per row, and a row with none offers nothing.
      else if (key === "open") opened(steps(tree).find((step) => step.key === view.selected)?.worktree ?? tree.worktree);
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
    // to see: the step tree changed, or something is turning — an open wait's
    // spinner, or the running step's marker. Both are the proof the run is
    // alive, and a marker frozen on one frame is exactly what a hung run looks
    // like.
    timer = globalThis.setInterval(() => {
      spin += 1;
      if (dirty || waiting(tree) || steps(tree).some((step) => step.state === "running")) draw();
    }, FRAME_MS);
    timer.unref?.();
    draw();
  };

  const show = (entry: RunEvent | string, address?: string) => {
    if (ended) return;
    const at = now();
    if (!mounted) {
      // A row's event before the screen is up belongs to a row that does not
      // exist yet: the `run` event is what makes the rows, and it is the
      // sweep's own, never a worker's.
      if (address !== undefined) return;
      if (typeof entry === "string" || entry.kind !== "run") return inner.show(entry);
      tree = take(tree, at, entry);
      view = follow(view, tree);
      return mount();
    }
    tree = take(tree, at, entry, address);
    view = follow(view, tree);
    dirty = true;
  };

  /**
   * One row's presenter. `end` is deliberately not the screen's: a worker
   * finishing is its journal's layer closing, and the screen outlives every
   * one of them.
   */
  const row = (name: string, worktree?: string): Presenter => {
    tree = bound(tree, name, worktree);
    dirty = true;
    return { show: (entry: RunEvent | string) => show(entry, name), end: () => {} };
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
    if (tree.worktree !== undefined)
      for (const line of display(`worktree: ${tree.worktree}`, dress)) stream.write(line + "\n");
    // Through `display`, like every other line this repo writes: it is where
    // the result's colour is decided and, more to the point, where the text is
    // scrubbed. An escalation's wording carries `gh` output and agent text,
    // and this is the line the operator reads the outcome off.
    if (tree.result) for (const line of display(tree.result, dress)) stream.write(line + "\n");
  };

  return { show: (entry: RunEvent | string) => show(entry), end, row };
};
