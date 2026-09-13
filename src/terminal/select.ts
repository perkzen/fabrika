import { Data, Effect } from "effect";
import { styleText } from "node:util";
import { CONFIG_PATH, type Config } from "../config.ts";
import { choices, type Choice } from "../pipeline/fabrika.ts";
import { isInteractive, type Style } from "./console.ts";
import { row, type Segment, type Size } from "./frame.ts";
import type { Styler } from "./markdown.ts";

/**
 * The operator left before the run began. A failure rather than an empty
 * answer, because an empty answer is a run of nothing — a thing they can
 * legitimately ask for — and walking away is not an answer at all.
 */
export class Cancelled extends Data.TaggedError("Cancelled")<{}> {}

export type Surface = {
  /** What the verdict is made on, and what the rows are drawn to: the stream the run would report to. */
  readonly stream: NodeJS.WriteStream;
  /** Where the answer is typed. A surface with no keyboard is never asked. */
  readonly input?: NodeJS.ReadStream;
};

/** Whether there is an operator here to answer a question: a dressed stdout is not enough without a keyboard. */
export const canAnswer = (surface: Surface) => isInteractive(surface.stream) && Boolean(surface.input?.isTTY);

/**
 * What is on offer, what is ticked, and which row the operator is on.
 *
 * `on` is parallel to `rows` rather than a set of names, so the two cannot
 * disagree about a step and nothing has to be looked up to draw a row.
 *
 * `at` counts the bulk row: `0` is it, and choice `n` is `n + 1`. It is a
 * row the operator lands on and toggles like any other, so the cursor has
 * one arithmetic rather than one for the list and an exception above it.
 */
export type Picker = {
  readonly rows: ReadonlyArray<Choice>;
  readonly on: ReadonlyArray<boolean>;
  readonly at: number;
};

/** Everything ticked, or nothing: what the bulk row does, and what it is called while it would do it. */
export const bulk = (state: Picker): { readonly title: string; readonly description: string } =>
  state.on.every(Boolean)
    ? { title: `Select None (${state.rows.length}/${state.rows.length})`, description: `Clear all ${state.rows.length} steps.` }
    : {
        title: `Select All (${state.on.filter(Boolean).length}/${state.rows.length})`,
        description: `Select all ${state.rows.length} steps.`,
      };

/** Everything ticked: the question is what to leave out of a run that would otherwise be whole. */
export const picker = (config: Config): Picker => {
  const rows = choices(config);
  return { rows, on: rows.map(() => true), at: 0 };
};

/** What the picker answers, in the run's order rather than the order the operator ticked. */
export const chosen = (state: Picker): ReadonlyArray<string> =>
  state.rows.filter((_, index) => state.on[index]).map((row) => row.name);

/**
 * What one keystroke means here.
 *
 * Its own table rather than the screen's: there, space and enter are one key
 * because both fold, and here they have to be two — space ticks a row and
 * enter is the answer. There is no key for all and none: the row at the top
 * of the list does both, which is a key the operator can see.
 *
 * A bare `Esc` means nothing, deliberately. An arrow key split across two
 * chunks arrives as a lone escape, which on the screen costs one ignored
 * keystroke; here, read as cancel, it would end a run the operator had not
 * started yet. `^C` is the one way out, as it is on the screen.
 */
export type Key = "up" | "down" | "toggle" | "all" | "none" | "confirm" | "cancel" | "unknown";

const SEQUENCES: ReadonlyArray<readonly [string, Key]> = [
  ["\x1b[A", "up"],
  ["\x1b[B", "down"],
  // What a terminal in application cursor mode sends instead.
  ["\x1bOA", "up"],
  ["\x1bOB", "down"],
  ["k", "up"],
  ["j", "down"],
  [" ", "toggle"],
  ["\r", "confirm"],
  ["\n", "confirm"],
  ["\x03", "cancel"],
];

/** One chunk of raw stdin as the keys in it — longest match first, so a lone `Esc` is read as one last. */
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
 * One keystroke applied to the picker. Pure, and total: `confirm` and
 * `cancel` end the select rather than changing it, so they leave it alone
 * and the driver is the one that reads them.
 *
 * The cursor stops at both ends rather than wrapping: a held arrow key that
 * comes back around is a list the operator has lost their place in.
 */
export const press = (key: Key, state: Picker): Picker => {
  switch (key) {
    case "up":
      return { ...state, at: Math.max(state.at - 1, 0) };
    case "down":
      return { ...state, at: Math.min(state.at + 1, state.rows.length) };
    // On the bulk row, space is the bulk: ticked becomes cleared and
    // anything else becomes all, which is what its own label says it will do.
    case "toggle":
      return state.at === 0
        ? press(state.on.every(Boolean) ? "none" : "all", state)
        : { ...state, on: state.on.map((was, index) => (index === state.at - 1 ? !was : was)) };
    case "all":
      return { ...state, on: state.on.map(() => true) };
    case "none":
      return { ...state, on: state.on.map(() => false) };
    default:
      return state;
  }
};

/**
 * The rail: a question is a step in a flow, and the flow is drawn down the
 * left of it — the chip that opens it, a diamond per step, `│` beside
 * everything a step has to say, and the settled row it leaves behind.
 */
const RAIL = { top: "┌ ", side: "│ ", step: "◇ ", here: "◆ ", quit: "■ " } as const;
/** Filled for a step the run will have, hollow for one it will not. */
const MARKERS = { on: "●", off: "○" } as const;
/** What sits in front of the row the operator is standing on, and the width of that column. */
const HERE = ") ";
const NOT_HERE = "  ";
const KEYS = "↑↓ move, space select, enter confirm";
/** What the rail costs: the chip, its blank, the config step, its blank, the title, the keys, and so on down. */
const CHROME = 13;

/** The rows, and the bulk row above them — the list as the operator moves through it. */
const listed = (state: Picker): ReadonlyArray<{ readonly title: string; readonly on?: boolean }> => [
  { title: bulk(state).title },
  ...state.rows.map((choice, index) => ({ title: choice.title, on: state.on[index]! })),
];

/** What the description block says about wherever the operator is standing. */
const describes = (state: Picker): string => (state.at === 0 ? bulk(state).description : state.rows[state.at - 1]!.description);

/** Which rows are drawn, when there are more of them than the terminal has room for. */
const window = (state: Picker, size: Size): { readonly from: number; readonly to: number } => {
  const all = state.rows.length + 1;
  const room = Math.max(size.rows - CHROME, 1);
  if (all <= room) return { from: 0, to: all };
  const from = Math.min(Math.max(state.at - Math.floor(room / 2), 0), all - room);
  return { from, to: from + room };
};

/**
 * The select as lines, at most `size.columns - 1` display columns each.
 *
 * Pure, the way `frame` is: a test drives it with the identity styler and
 * asserts on whole lines, and nothing in here knows there is a terminal. It
 * lays every line out as segments and hands them to the outline's own `row`,
 * which cuts by the text and dresses after — a line cut through the middle
 * of an escape is no longer one row, and one row is what the redraw
 * arithmetic below counts on.
 */
export const lines = (state: Picker, size: Size, dress: Styler): ReadonlyArray<string> => {
  const width = Math.max(size.columns - 1, 1);
  const rail = (text = ""): Segment => ({ style: "dim", text: `${RAIL.side}${text}` });
  const rows = listed(state);
  const { from, to } = window(state, size);
  const all = state.on.every(Boolean);
  const clipped = (hidden: number, arrow: string): ReadonlyArray<ReadonlyArray<Segment>> =>
    hidden > 0 ? [[rail(`    ${arrow} ${hidden} more`)]] : [];

  const listing = rows.slice(from, to).flatMap((entry, index): ReadonlyArray<ReadonlyArray<Segment>> => {
    const at = from + index;
    const here = at === state.at;
    // The bulk row has no state of its own: it wears the mark of the list it
    // would act on, which is what makes its label and its marker agree.
    const on = entry.on ?? all;
    const line: ReadonlyArray<Segment> = [
      rail(),
      { style: here ? "cyan" : undefined, text: here ? HERE : NOT_HERE },
      { style: on ? "green" : "dim", text: `${on ? MARKERS.on : MARKERS.off} ` },
      { style: here ? ["underline", "cyan"] : undefined, text: entry.title },
    ];
    // The rule separates the bulk row from the list, so it is drawn under
    // that row and nowhere else — including not at all when the list has
    // scrolled far enough that the bulk row is off the top.
    return at === 0
      ? [line, [rail(`  ${"─".repeat(Math.max(...rows.map((row) => row.title.length)) + 2)}`)]]
      : [line];
  });

  const block: ReadonlyArray<ReadonlyArray<Segment>> = [
    [{ style: "dim", text: RAIL.top }, { style: ["inverse", "cyan"], text: " fabrika " }],
    [rail()],
    [{ style: "green", text: RAIL.step }, { text: `${state.rows.length} steps in ${CONFIG_PATH}` }],
    [rail()],
    [{ style: ["bold", "green"], text: RAIL.here }, { style: "bold", text: "Steps to run" }],
    [rail(KEYS)],
    [rail()],
    ...clipped(from, "↑"),
    ...listing,
    ...clipped(rows.length - to, "↓"),
    [rail()],
    [rail("Description")],
    [rail(describes(state))],
  ];
  return block.map((segments) => row(segments, width, dress));
};

/** The one row the answered question leaves behind, closing the rail it opened. */
export const settled = (names: ReadonlyArray<string>, dress: Styler): string =>
  row(
    [
      { style: "green", text: RAIL.step },
      { text: `steps: ${names.length > 0 ? names.join(" · ") : "none — the worktree and nothing else"}` },
    ],
    Number.MAX_SAFE_INTEGER,
    dress,
  );

/** And the row it leaves behind when the operator walks away instead. */
export const abandoned = (dress: Styler): string =>
  row([{ style: "dim", text: `${RAIL.quit}cancelled` }], Number.MAX_SAFE_INTEGER, dress);

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/**
 * Asks which steps to run, or answers `undefined` for a surface that cannot
 * be asked — a pipe, `NO_COLOR`, CI, and any shell an agent drives, all of
 * which run the whole pipeline as they always have. A run nobody can answer
 * must never stop on a question.
 *
 * Drawn into scrollback rather than onto the alternate buffer: the banner
 * above it is worth keeping, and what the operator settled on is worth
 * leaving behind. The block is redrawn in place by clearing back up to its
 * first row, which is the scrollback console's device and correct for the
 * same reason — every line is cut to the terminal, so one line is one row.
 *
 * The keyboard is handed back cooked and flowing, which is the state the
 * screen's own `setRawMode` and `resume` expect to find it in: the two
 * readers of stdin in one command never overlap, because this one is over
 * before the run that mounts the other has started.
 */
export const selectSteps = (config: Config, surface: Surface) =>
  canAnswer(surface)
    ? Effect.callback<ReadonlyArray<string> | undefined, Cancelled>((resume) => {
        const stream = surface.stream;
        const input = surface.input!;
        const dress: Styler = (style, text) => (style ? styleText(style, text, { validateStream: false }) : text);
        const size = () => ({
          columns: typeof stream.columns === "number" && stream.columns > 1 ? stream.columns : 80,
          rows: typeof stream.rows === "number" && stream.rows > 0 ? stream.rows : 24,
        });

        let state = picker(config);
        let drawn = 0;

        const draw = () => {
          if (drawn > 0) stream.write(`\x1b[${drawn}A\x1b[0J`);
          const rows = lines(state, size(), dress);
          stream.write(rows.map((line) => `${line}\n`).join(""));
          drawn = rows.length;
        };

        /** The block goes, and one line takes its place: what the run is about to be, in scrollback for good. */
        const leave = (said?: string) => {
          input.off("data", onKey);
          input.setRawMode(false);
          // Paused, the way the screen unmounts: a flowing stdin with nothing
          // listening holds the event loop open, and a run that short-circuits
          // before the screen mounts has nothing else to pause it.
          input.pause();
          if (drawn > 0) stream.write(`\x1b[${drawn}A\x1b[0J`);
          drawn = 0;
          stream.write(SHOW_CURSOR);
          // Nothing to say when the fiber was cancelled from elsewhere: the
          // terminal is put back, and whatever interrupted the run owns the
          // line that explains it.
          if (said !== undefined) stream.write(`${said}\n`);
        };

        function onKey(chunk: Buffer | string) {
          for (const key of decode(String(chunk))) {
            if (key === "confirm") {
              const names = chosen(state);
              leave(settled(names, dress));
              return resume(Effect.succeed(names));
            }
            if (key === "cancel") {
              leave(abandoned(dress));
              return resume(Effect.fail(new Cancelled()));
            }
            state = press(key, state);
          }
          draw();
        }

        stream.write(HIDE_CURSOR);
        input.setRawMode(true);
        input.resume();
        input.on("data", onKey);
        draw();

        // Interruption is the run's, not a key's: `^C` is decoded above, and
        // this is the fiber being cancelled from elsewhere. The terminal is
        // put back either way, because a cursor left hidden outlives fabrika.
        return Effect.sync(() => {
          if (drawn > 0) leave();
        });
      })
    : Effect.succeed(undefined);
