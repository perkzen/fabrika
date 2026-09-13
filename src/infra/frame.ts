import type { Styler } from "./markdown.ts";
import type { Style } from "./console.ts";
import type { Node, StepState, Tree } from "../outline.ts";
import { scrub } from "../run-event.ts";

/**
 * What the operator has selected, unfolded and scrolled to — the step tree's
 * companion, and the only thing a key press changes.
 */
export type View = {
  /** The selected step's key. */
  readonly selected: string;
  /** The one unfolded step, or none. At most one is open at a time. */
  readonly opened: string | null;
  /** True when `opened` is the operator's choice rather than "the running step". */
  readonly chosen: boolean;
  /** Rows scrolled up from the bottom of the open window. Zero is following the tail. */
  readonly scroll: number;
  /** First outline row drawn, so a long outline can scroll. */
  readonly top: number;
};

export type Size = { readonly columns: number; readonly rows: number };

/** `now` and `spin` are arguments rather than reads, so an elapsed time is a fact a test states. */
export type Clock = { readonly now: number; readonly spin: number };

/** The same bar the scrollback console's live region draws. */
const BAR = 12;

/** How a step's state reads at a glance. Already-done borrows done's tick and is dimmed instead. */
const MARKERS: Record<StepState, string> = {
  pending: "·",
  running: "▸",
  done: "✔",
  failed: "✖",
  skipped: "–",
  "already-done": "✔",
};

/** A piece of a row and how it is dressed, so a row can be cut by its text and styled after. */
type Segment = { readonly style?: Style; readonly text: string };

/**
 * The whole viewport, as exactly `size.rows` lines of at most
 * `size.columns - 1` display columns each.
 *
 * Pure: everything it needs is an argument, so a test drives it with the
 * identity styler and a wound clock and asserts on whole frames. One line is
 * one row — a row wider than the terminal is cut, never wrapped — which is
 * what keeps the screen's cursor arithmetic to a home and a write.
 */
export const frame = (tree: Tree, view: View, size: Size, dress: Styler, _clock: Clock): ReadonlyArray<string> => {
  const width = Math.max(size.columns - 1, 0);
  const root = tree.roots.at(-1);
  const lines: Array<string> = [];
  if (root) {
    lines.push(row(header(root, tree.label), width, dress));
    for (const step of root.children) lines.push(row(outlineRow(step), width, dress));
  }
  return [...lines.slice(0, size.rows), ...Array<string>(Math.max(size.rows - lines.length, 0)).fill("")];
};

/** The run's own line: what it is, how far through it is, and what it is doing. */
const header = (root: Node, label: string | undefined): ReadonlyArray<Segment> => {
  const filled = Math.round((Math.max(root.at - 1, 0) / Math.max(root.of, 1)) * BAR);
  const bar = "█".repeat(filled) + "░".repeat(BAR - filled);
  const running = root.children.find((child) => child.at === root.at);
  return [
    ...(label ? [{ text: `${label} ` }] : []),
    { text: `[${bar}] ${root.at}/${root.of}${running ? ` ${running.name}` : ""}` },
  ];
};

const outlineRow = (step: Node): ReadonlyArray<Segment> => [
  { text: `${MARKERS[step.state]} ${step.at}/${step.of} ` },
  { style: "bold", text: step.name },
];

/**
 * Cut by the text and dressed after, never the other way round: slicing a
 * styled line mid-escape corrupts it, and a line of exactly `columns - 1`
 * occupies exactly one row. Scrubbed for the same reason — one escape in a
 * step's name and a row is no longer a row.
 */
const row = (segments: ReadonlyArray<Segment>, width: number, dress: Styler): string => {
  const out: Array<string> = [];
  let left = width;
  for (const segment of segments) {
    if (left <= 0) break;
    const text = scrub(segment.text).slice(0, left);
    left -= text.length;
    out.push(segment.style ? dress(segment.style, text) : text);
  }
  return out.join("");
};
