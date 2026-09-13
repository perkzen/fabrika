import { display, livenessRow, progressRow, type Clock } from "./lines.ts";
import type { Styler } from "./markdown.ts";
import type { Style } from "./console.ts";
import type { Node, StepState, Tree } from "../outline.ts";
import { elapsed, scrub, stamp } from "../run-event.ts";

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

/** Fewer rows than this and the footer is the first thing to go. */
const FOOTER_AT = 12;
/** A window of one or two rows tells nobody anything; below the floor it is not drawn at all. */
const WINDOW = 3;
/** The keys, named once, because keys nobody can discover are keys nobody uses. */
const KEYS = "↑↓ select  space fold  PgUp/PgDn scroll  Esc follow  Ctrl-C interrupt";

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
export const frame = (tree: Tree, view: View, size: Size, dress: Styler, clock: Clock): ReadonlyArray<string> => {
  const width = Math.max(size.columns - 1, 0);
  const root = tree.roots.at(-1);
  if (!root) return blank(size.rows);

  const { window, outline, top, footer } = layout(tree, view, size);
  const spare = window + outline;
  // Only when the budget gave it rows: below the floor there is no window at
  // all, and a liveness row drawn anyway would cost the outline its last step.
  const open = window > 0 ? root.children.find((child) => child.key === view.opened) : undefined;
  // The spinner belongs to the step the run is inside; an unfolded finished
  // step is being read, not watched.
  const live = open?.state === "running" ? liveness(tree, clock) : undefined;

  const drawn = root.children.slice(top, top + outline);
  const body: Array<string> = [];
  for (const step of drawn) {
    body.push(row(outlineRow(step, step.key === view.selected), width, dress));
    if (open && step.key === open.key) body.push(...windowRows(open, window, width, view, dress, live));
  }
  // The open step's own row can be scrolled out of the outline; its window is
  // still owed the rows the budget gave it.
  if (open && !drawn.includes(open)) body.push(...windowRows(open, window, width, view, dress, live));

  return [
    row(header(root, tree.label), width, dress),
    ...[...body, ...blank(spare)].slice(0, spare),
    ...(footer ? [row([{ style: "dim", text: KEYS }], width, dress)] : []),
  ];
};

/**
 * How the viewport is divided, in one calculation.
 *
 * A frame is a header row, a body, and a footer when there is room for one;
 * the body is the outline, with the open step's window taking rows out of the
 * middle of it. The window shrinks before the outline does, and is not drawn
 * at all when it cannot have its floor: with a header, an outline of at least
 * one row and a window of at least three, a terminal under five rows cannot
 * have all three, and the outline is the one always needed.
 */
export type Layout = {
  /** How many body rows the open step's window takes, and so how far a page key scrolls it. */
  readonly window: number;
  /** How many body rows are left for the outline. */
  readonly outline: number;
  /**
   * The first outline row to draw: `view.top`, pulled to wherever it has to be
   * for the selected step and the running step to both be on screen, and never
   * past either end.
   *
   * The key handler sets `top` as it moves the selection, and this clamps what
   * it set — so a resize that shrank the terminal cannot leave a stale `top`
   * hiding the selection. When the two are too far apart to both fit, the
   * selection wins: it is the operator's choice, and the running step already
   * has the window.
   */
  readonly top: number;
  /** Whether the terminal is tall enough to name the keys at the bottom. */
  readonly footer: boolean;
};

/**
 * The budget, computed once for whoever is about to spend it — the renderer
 * laying out a frame, and the key handler deciding how far a page scrolls and
 * where the selection drags the outline to.
 */
export const layout = (tree: Tree, view: View, size: Size): Layout => {
  const steps = tree.roots.at(-1)?.children ?? [];
  const footer = size.rows >= FOOTER_AT;
  const body = Math.max(size.rows - 1 - (footer ? 1 : 0), 0);
  const window =
    steps.some((step) => step.key === view.opened) && body >= WINDOW + 1 ? Math.max(WINDOW, body - steps.length) : 0;
  const outline = body - window;

  // At least one, so an outline with no room left still has a row to clamp
  // against rather than dividing the selection into nothing.
  const shown = Math.max(outline, 1);
  const last = Math.max(steps.length - shown, 0);
  const at = steps.findIndex((step) => step.key === view.selected);
  const running = steps.findIndex((step) => step.state === "running");
  // The running step is held on screen beside the selection whenever the two
  // are close enough to share the outline; past that it is dropped and the
  // selection alone decides where the outline sits.
  const together = at >= 0 && running >= 0 && Math.abs(running - at) < shown;
  const first = together ? Math.min(at, running) : at;
  const lastWanted = together ? Math.max(at, running) : at;
  const top =
    at < 0
      ? Math.min(Math.max(view.top, 0), last)
      : Math.min(Math.max(Math.min(view.top, first), lastWanted - shown + 1, 0), last);

  return { window, outline, top, footer };
};

const blank = (rows: number): ReadonlyArray<string> => Array<string>(Math.max(rows, 0)).fill("");

/**
 * The open step's own stream, stamped per physical line, wrapped, and showing
 * the last `height` rows offset by `view.scroll`.
 *
 * Rendered from the tail backwards and stopped as soon as it has the rows it
 * needs: a frame is drawn twelve times a second while a wait is open, and a
 * step's stream reaches thousands of entries, so walking all of them — and
 * re-lexing every markdown message — is what would make the screen stutter.
 */
const windowRows = (
  step: Node,
  height: number,
  width: number,
  view: View,
  dress: Styler,
  live: ReadonlyArray<Segment> | undefined,
): ReadonlyArray<string> => {
  const rows = live === undefined ? height : height - 1;
  const rendered = tail(step, rows + view.scroll, width, dress);
  // A scroll past the top shows the top, never blankness: the stream can
  // shrink under a scroll that was good for it, and a resize can too.
  const end = rendered.length - Math.min(view.scroll, Math.max(rendered.length - rows, 0));
  const shown = rendered.slice(Math.max(end - rows, 0), end);
  // Top-aligned when the stream is shorter than the window, the way a terminal
  // fills a buffer it has not used up; the liveness row is always the last.
  return [...shown, ...blank(rows - shown.length), ...(live === undefined ? [] : [row(live, width, dress)])];
};

/** A step's stream as rows, newest last, walked back from the tail no further than `wanted` of them. */
const tail = (step: Node, wanted: number, width: number, dress: Styler): ReadonlyArray<string> => {
  const rendered: Array<string> = [];
  for (let index = step.stream.length - 1; index >= 0 && rendered.length < wanted; index -= 1) {
    const entry = step.stream[index]!;
    const when = dress("dim", stamp(entry.when));
    rendered.unshift(...display(entry.entry, dress).flatMap((line) => wrap(`${when} ${line}`, width)));
  }
  return rendered;
};

/** Styling changes a row's bytes, never how many rows there are, so counting can skip it. */
const BARE: Styler = (_style, text) => text;

/**
 * The scroll the open window can actually have, for a key handler that has
 * just asked for one: never further up than the stream goes, so a page key
 * cannot walk the window off into blankness and charge as many presses to
 * come back. Walked no further than the asked-for position needs.
 */
export const scrolled = (tree: Tree, view: View, size: Size, scroll: number): number => {
  const { window } = layout(tree, view, size);
  const step = (tree.roots.at(-1)?.children ?? []).find((child) => child.key === view.opened);
  if (!step || window <= 0) return 0;
  const rows = window - (step.state === "running" && livenessRow(tree, { now: 0, spin: 0 }) !== undefined ? 1 : 0);
  if (rows <= 0) return 0;
  const height = tail(step, rows + Math.max(scroll, 0), Math.max(size.columns - 1, 0), BARE).length;
  return Math.min(Math.max(scroll, 0), Math.max(height - rows, 0));
};

/**
 * What the run is blocked on, as the window's last row — the live region's
 * second line, moved to where the work is.
 *
 * The command is the window's own addition: a gate's `start` line is in the
 * stream right above this row on a screen, where on scrollback it is already
 * behind the operator.
 */
const liveness = (tree: Tree, clock: Clock): ReadonlyArray<Segment> | undefined => {
  const row = livenessRow(tree, clock);
  if (row === undefined) return undefined;
  return [{ style: "dim", text: tree.gate ? `${row}: ${tree.gate.command}` : row }];
};

/**
 * A line broken into rows of at most `width` display columns.
 *
 * Widths are counted ignoring SGR runs, because the escapes this repo emits
 * occupy no columns; a run left open at a break simply continues onto the next
 * row, which is what a terminal does with SGR state. Window rows are wrapped
 * rather than cut, because a window exists to read agent prose and a cut
 * sentence defeats it.
 *
 * Counted in code points rather than UTF-16 units: an agent writes emoji
 * constantly, and one broken across a row boundary renders as two pieces of
 * garbage. A double-width character still costs one, the way ADR-0001's
 * truncation always has.
 */
/**
 * The two characters `scrub` keeps, as the one column a row counts them as.
 *
 * `scrub` keeps tab and newline because an event's text also goes to
 * `log.txt`, and a file has tab stops and paragraphs. A row has neither: a
 * terminal advances a tab to the next multiple of eight and starts a new
 * physical line on a newline, so either one in an agent's code block or a
 * config-written step name makes the frame taller than the `size.rows` the
 * cursor arithmetic drew it as — permanently, because a wrap on the last row
 * scrolls the alternate buffer out from under the next `HOME`.
 */
const flattened = (text: string): string => text.replace(/[\t\n]/g, " ");

const wrap = (line: string, width: number): ReadonlyArray<string> => {
  if (width <= 0) return [""];
  const rows: Array<string> = [];
  let row = "";
  let used = 0;
  for (const piece of flattened(line).match(/\x1b\[[0-9;]*m|[\s\S]/gu) ?? []) {
    if (piece.startsWith("\x1b")) {
      row += piece;
      continue;
    }
    if (used === width) {
      rows.push(row);
      row = "";
      used = 0;
    }
    row += piece;
    used += 1;
  }
  rows.push(row);
  return rows;
};

/**
 * The outline alone, one dressed row per step and nothing else.
 *
 * What a screen writes to plain scrollback as it leaves: the run summarised,
 * with no header and no footer, because those are devices of a live viewport
 * and this is a line an operator scrolls back to an hour later.
 */
export const rows = (tree: Tree, columns: number, dress: Styler): ReadonlyArray<string> =>
  // Nothing is selected in scrollback: the run is over and there is no view.
  (tree.roots.at(-1)?.children ?? []).map((step) => row(outlineRow(step, false), Math.max(columns - 1, 0), dress));

/** The run's own line: what the operator calls it, and the progress row every surface draws. */
const header = (root: Node, label: string | undefined): ReadonlyArray<Segment> => {
  const running = root.children.find((child) => child.at === root.at);
  return [
    ...(label ? [{ text: `${label} ` }] : []),
    { text: progressRow({ at: root.at, of: root.of, name: running?.name ?? "" }) },
  ];
};

/**
 * One step, as the operator reads it: what state it is in, where it is, what
 * it is called, and — once it has finished — what it came to.
 *
 * The fields are in one order and the row is cut from the right, so the
 * marker, the position, the name and the state survive any terminal.
 *
 * The selected row is marked by dressing its marker and position rather than
 * by a field of its own: the line's text is what the operator reads, and
 * which row they are on is the surface's business, the way a failed gate's
 * red is.
 */
const outlineRow = (step: Node, selected: boolean): ReadonlyArray<Segment> => [
  { style: selected ? "inverse" : undefined, text: `${MARKERS[step.state]} ${step.at}/${step.of}` },
  { text: " " },
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
    ...(calls === 0 ? [] : [{ text: `${FIELD}${calls} call${calls === 1 ? "" : "s"} (${named(tools)})` }]),
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
    const text = flattened(scrub(segment.text)).slice(0, left);
    left -= text.length;
    out.push(segment.style ? dress(segment.style, text) : text);
  }
  return out.join("");
};
