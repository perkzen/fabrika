import type { Styler } from "./markdown.ts";
import type { Style } from "./console.ts";
import type { Node, StepState, Tree } from "../outline.ts";
import { elapsed, scrub } from "../run-event.ts";

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

/** Summary fields are joined by two spaces, and each is omitted when it has nothing to say. */
const FIELD = "  ";
/** Past three tools the list stops naming them and says how many it left out. */
const TOOLS = 3;

/** How a gate verdict reads in a summary — the same three words the gate's own line uses. */
const VERDICTS = { pass: "ok", fail: "FAILED", skipped: "skipped" } as const;

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

/**
 * The outline alone, one dressed row per step and nothing else.
 *
 * What a screen writes to plain scrollback as it leaves: the run summarised,
 * with no header and no footer, because those are devices of a live viewport
 * and this is a line an operator scrolls back to an hour later.
 */
export const rows = (tree: Tree, columns: number, dress: Styler): ReadonlyArray<string> =>
  (tree.roots.at(-1)?.children ?? []).map((step) => row(outlineRow(step), Math.max(columns - 1, 0), dress));

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

/**
 * One step, as the operator reads it: what state it is in, where it is, what
 * it is called, and — once it has finished — what it came to.
 *
 * The fields are in one order and the row is cut from the right, so the
 * marker, the position, the name and the state survive any terminal.
 */
const outlineRow = (step: Node): ReadonlyArray<Segment> => [
  { text: `${MARKERS[step.state]} ${step.at}/${step.of} ` },
  { style: nameStyle(step.state), text: step.name },
  ...summary(step),
];

/** A failed step is the one line worth reading; a skipped or resumed one recedes. */
const nameStyle = (state: StepState): Style =>
  state === "failed" ? ["bold", "red"] : state === "skipped" || state === "already-done" ? "dim" : "bold";

/** What a step came to: a rollup once it has finished, a reason if it never ran, nothing yet otherwise. */
const summary = (step: Node): ReadonlyArray<Segment> => {
  const { seconds, usd, calls, tools, skills, gates, reason } = step.summary;
  if (step.state === "skipped") return [{ style: "dim", text: `${FIELD}skipped${reason ? ` (${reason})` : ""}` }];
  if (step.state === "already-done") return [{ style: "dim", text: `${FIELD}already done` }];
  if (step.state !== "done" && step.state !== "failed") return [];
  return [
    ...(seconds === undefined ? [] : [{ text: `${FIELD}${elapsed(seconds)}` }]),
    ...(usd === undefined ? [] : [{ text: `${FIELD}$${usd.toFixed(2)}` }]),
    ...(calls === 0 ? [] : [{ text: `${FIELD}${calls} calls (${named(tools)})` }]),
    ...(skills.length === 0 ? [] : [{ text: `${FIELD}${skills.join(", ")}` }]),
    ...verdicts(gates),
  ];
};

const named = (tools: Node["summary"]["tools"]): string => {
  const left = tools.length - TOOLS;
  return [...tools.slice(0, TOOLS).map((seen) => `${seen.tool} ${seen.count}`), ...(left > 0 ? [`+${left} more`] : [])].join(", ");
};

/** Each gate command's verdict and time, the failed one still bold red at this grain. */
const verdicts = (gates: Node["summary"]["gates"]): ReadonlyArray<Segment> =>
  gates.length === 0
    ? []
    : [
        { text: `${FIELD}gate: ` },
        ...gates.flatMap((gate, index): ReadonlyArray<Segment> => [
          ...(index === 0 ? [] : [{ text: ", " }]),
          {
            style: gate.state === "fail" ? (["bold", "red"] satisfies Style) : undefined,
            text: `${gate.name} ${VERDICTS[gate.state]}${gate.seconds === undefined ? "" : ` ${gate.seconds}s`}`,
          },
        ]),
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
