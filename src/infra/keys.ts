import { layout, scrolled, type Size, type View } from "./frame.ts";
import { steps as outlineSteps, type Node, type Tree } from "../outline.ts";

/**
 * What one keystroke means. Keys change what is shown, never what is done, so
 * a run in a terminal whose operator went home has the same outcome, the same
 * exit code and the same last line.
 */
export type Key = "up" | "down" | "toggle" | "page-up" | "page-down" | "follow" | "interrupt" | "unknown";

/**
 * The smallest set that covers every behaviour asked for, all of it
 * guessable. Longest match first, so a lone `Esc` is only read as one after
 * every sequence that starts with it has been ruled out.
 */
const SEQUENCES: ReadonlyArray<readonly [string, Key]> = [
  ["\x1b[A", "up"],
  ["\x1b[B", "down"],
  ["\x1b[5~", "page-up"],
  ["\x1b[6~", "page-down"],
  // What a terminal in application cursor mode sends instead.
  ["\x1bOA", "up"],
  ["\x1bOB", "down"],
  ["\x1b", "follow"],
  ["k", "up"],
  ["j", "down"],
  [" ", "toggle"],
  ["\r", "toggle"],
  ["\n", "toggle"],
  ["\x03", "interrupt"],
];

/**
 * One chunk of raw stdin as the keys in it — a paste or a held key arrives as
 * several. An escape sequence split across two chunks decodes as `follow` plus
 * junk, which is one ignored keystroke and nothing worse: keys are optional
 * and change only what is shown.
 */
export const decode = (chunk: string): ReadonlyArray<Key> => {
  const keys: Array<Key> = [];
  let at = 0;
  while (at < chunk.length) {
    const found = SEQUENCES.find(([bytes]) => chunk.startsWith(bytes, at));
    keys.push(found ? found[1] : "unknown");
    at += found ? found[0].length : 1;
  }
  return keys;
};

/**
 * One keystroke applied to the view. Pure: it returns a new view and reads
 * the tree only to know what there is to select.
 *
 * `interrupt` is deliberately not handled here — raw mode stops the terminal
 * raising SIGINT, so the presenter turns it into a signal and lets the runner
 * interrupt the fiber. Exiting here would preempt the finalisers that clean up
 * the MCP temp files.
 */
export const press = (key: Key, view: View, tree: Tree, size: Size): View => {
  const steps = outlineSteps(tree);
  switch (key) {
    case "up":
    case "down":
      return moved(view, steps, key === "up" ? -1 : 1, tree, size);
    // Opens the selected step and closes whatever was open, or closes it if it
    // was the one open. At most one is open, so the view can never become the
    // wall again.
    case "toggle":
      return { ...view, chosen: true, opened: view.opened === view.selected ? null : view.selected, scroll: 0 };
    case "page-up":
      return { ...view, scroll: scrolled(tree, view, size, view.scroll + page(tree, view, size)) };
    case "page-down":
      return { ...view, scroll: Math.max(view.scroll - page(tree, view, size), 0) };
    case "follow":
      return follow({ ...view, chosen: false, scroll: 0 }, tree);
    default:
      return view;
  }
};

/**
 * The view the operator gets by doing nothing: the selection and the fold on
 * the running step. Applied after every event, so a step folds itself when it
 * ends — unless the operator unfolded one by hand, which is what `chosen` says.
 */
export const follow = (view: View, tree: Tree): View => {
  if (view.chosen) return view;
  const running = outlineSteps(tree).find((step) => step.state === "running");
  const opened = running?.key ?? null;
  // A different window is a different scroll position; the same one keeps
  // whatever the operator scrolled it to.
  return opened === view.opened ? view : { ...view, selected: running?.key ?? view.selected, opened, scroll: 0 };
};

const moved = (view: View, steps: ReadonlyArray<Node>, by: number, tree: Tree, size: Size): View => {
  const at = steps.findIndex((step) => step.key === view.selected);
  const next = steps[Math.min(Math.max((at < 0 ? 0 : at) + by, 0), steps.length - 1)];
  if (!next) return view;
  // `top` is kept here rather than derived per frame, so an outline longer
  // than the terminal scrolls with the selection instead of jumping back to
  // wherever the last frame happened to clamp it.
  const moving = { ...view, selected: next.key, chosen: true };
  return { ...moving, top: layout(tree, moving, size).top };
};

/** A page is a window, so a page key moves the reader exactly one screenful of what they are reading. */
const page = (tree: Tree, view: View, size: Size) => Math.max(layout(tree, view, size).window, 1);
