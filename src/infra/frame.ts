import { display } from "./lines.ts";
import type { Styler } from "./markdown.ts";
import { FRAMES, type Style } from "./console.ts";
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

  const footer = size.rows >= FOOTER_AT;
  const spare = Math.max(size.rows - 1 - (footer ? 1 : 0), 0);
  const open = root.children.find((child) => child.key === view.opened);
  // The window shrinks before the outline does, and is not drawn at all when
  // it cannot have its floor: under five rows the outline is the thing needed.
  const height = open && spare >= WINDOW + 1 ? Math.max(WINDOW, spare - root.children.length) : 0;
  // The spinner belongs to the step the run is inside; an unfolded finished
  // step is being read, not watched.
  const live = open?.state === "running" ? liveness(tree, clock) : undefined;

  const drawn = root.children.slice(view.top, view.top + (spare - height));
  const body: Array<string> = [];
  for (const step of drawn) {
    body.push(row(outlineRow(step), width, dress));
    if (open && step.key === open.key) body.push(...windowRows(open, height, width, view, dress, live));
  }
  // The open step's own row can be scrolled out of the outline; its window is
  // still owed the rows the budget gave it.
  if (open && height > 0 && !drawn.includes(open)) body.push(...windowRows(open, height, width, view, dress, live));

  return [
    row(header(root, tree.label), width, dress),
    ...[...body, ...blank(spare)].slice(0, spare),
    ...(footer ? [row([{ style: "dim", text: KEYS }], width, dress)] : []),
  ];
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
  const wanted = rows + view.scroll;
  const rendered: Array<string> = [];
  for (let index = step.stream.length - 1; index >= 0 && rendered.length < wanted; index -= 1) {
    const entry = step.stream[index]!;
    const at = dress("dim", stamp(entry.at));
    rendered.unshift(...display(entry.entry, dress).flatMap((line) => wrap(`${at} ${line}`, width)));
  }
  const end = Math.max(rendered.length - view.scroll, 0);
  const shown = rendered.slice(Math.max(end - rows, 0), end);
  // Top-aligned when the stream is shorter than the window, the way a terminal
  // fills a buffer it has not used up; the liveness row is always the last.
  return [...shown, ...blank(rows - shown.length), ...(live === undefined ? [] : [row(live, width, dress)])];
};

/**
 * What the run is blocked on, as the window's last row: an open wait's
 * spinner, elapsed time and deadline, or the gate step running now and the
 * command it is on. It is the live region's second line, moved to where the
 * work is.
 */
const liveness = (tree: Tree, clock: Clock): ReadonlyArray<Segment> | undefined => {
  // A gate is a synchronous shell run and a wait is not, so the two can never
  // both be open; the row belongs to whichever one is.
  if (tree.wait) {
    const against = tree.wait.deadlineMinutes ? ` / ${tree.wait.deadlineMinutes}m` : "";
    const spinner = FRAMES[clock.spin % FRAMES.length];
    const elapsedSince = elapsed((clock.now - tree.wait.since) / 1000);
    return [{ style: "dim", text: `${spinner} waiting for ${tree.wait.subject} — ${elapsedSince}${against}` }];
  }
  if (tree.gate) return [{ style: "dim", text: `gate ${tree.gate.at}/${tree.gate.of} ${tree.gate.name}: ${tree.gate.command}` }];
  return undefined;
};

/**
 * A line broken into rows of at most `width` display columns.
 *
 * Widths are counted ignoring SGR runs, because the escapes this repo emits
 * occupy no columns; a run left open at a break simply continues onto the next
 * row, which is what a terminal does with SGR state. Window rows are wrapped
 * rather than cut, because a window exists to read agent prose and a cut
 * sentence defeats it.
 */
const wrap = (line: string, width: number): ReadonlyArray<string> => {
  if (width <= 0) return [""];
  const rows: Array<string> = [];
  let row = "";
  let used = 0;
  for (const piece of line.match(/\x1b\[[0-9;]*m|[\s\S]/g) ?? []) {
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
