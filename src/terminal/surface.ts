/**
 * The terminal every surface is drawn on: the interactivity verdict, the
 * vocabulary a line is dressed in, the size it is cut to, the escape
 * sequences that move the cursor, and the loop that turns raw stdin into
 * keys.
 *
 * It sits under the presenters rather than inside one of them. A screen, a
 * scrollback console, a select and a banner each need most of this, and while
 * it lived in `console.ts` every one of them imported a presenter to reach a
 * type and then wrote its own `dress`, its own column guess and its own
 * cursor constants — four copies of each, which is four places for them to
 * drift.
 *
 * Nothing here knows what a run is. `RunEvent` and the step tree are the
 * presenters' business; this is the machine they are drawn on.
 */
import { styleText } from "node:util";
import type { RunEvent } from "../domain/run-event.ts";

/**
 * The stateful owner of one output surface. One per surface; only the
 * console's animates.
 *
 * Here rather than beside one of them because every surface answers it and
 * the journal fans out across them with no idea which it has — including the
 * archive, whose surface is a file and which needs none of the rest of this.
 */
export type Presenter = {
  readonly show: (entry: RunEvent | string) => void;
  readonly end: () => void;
};

/** The shape `styleText` takes, named once so every surface that dresses a line reads the same alias. */
export type Style = Parameters<typeof styleText>[0];

/**
 * How a line is dressed. The plain walk passes a styler that returns its text
 * untouched, so both terminal modes break lines in exactly the same places
 * and differ only in escape codes.
 *
 * The other half of the same vocabulary as `Style`, which is why the two live
 * together: a caller that has one always needs the other.
 */
export type Styler = (style: Style, text: string) => string;

/** What a surface is: the stream a run reports to, and the keyboard that can answer it. */
export type Surface = {
  /** What the verdict is made on, and what the rows are drawn to. */
  readonly stream: NodeJS.WriteStream;
  /** Where keys come from. A surface with no keyboard is never asked anything. */
  readonly input?: NodeJS.ReadStream;
};

/** A terminal's two axes, as a frame is laid out against them. */
export type Size = { readonly columns: number; readonly rows: number };

/**
 * A run is either fully dressed or fully plain, never partly: one verdict out
 * of all four inputs, so a `NO_COLOR` run and a piped run look the same.
 */
export const isInteractive = (stream: NodeJS.WriteStream) =>
  Boolean(stream.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb" && !process.env.CI;

/** Whether there is an operator here to answer a question: a dressed stdout is not enough without a keyboard. */
export const canAnswer = (surface: Surface) => isInteractive(surface.stream) && Boolean(surface.input?.isTTY);

/**
 * The one way a line is dressed. `validateStream` is off because the stream
 * the text is going to is the caller's business and has already been ruled on
 * by `isInteractive`; a plain surface is handed the identity instead.
 */
export const styler =
  (interactive: boolean): Styler =>
  (style, text) =>
    interactive && style ? styleText(style, text, { validateStream: false }) : text;

/** A non-TTY sink reports no size; these are the only sane guesses. */
const COLUMNS = 80;
const ROWS = 24;

/**
 * The terminal's size, read per draw rather than listened for, so a resize
 * needs no handler for the size itself — only for the redraw.
 */
export const sizeOf = (stream: NodeJS.WriteStream): Size => ({
  columns: typeof stream.columns === "number" && stream.columns > 1 ? stream.columns : COLUMNS,
  rows: typeof stream.rows === "number" && stream.rows > 0 ? stream.rows : ROWS,
});

export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";
export const ALTERNATE_ON = "\x1b[?1049h";
export const ALTERNATE_OFF = "\x1b[?1049l";
export const HOME = "\x1b[H";
export const CLEAR_LINE = "\x1b[K";
export const CLEAR_BELOW = "\x1b[0J";

/**
 * Back to the top of a block that was drawn and out to the end of the screen
 * — how a block written into scrollback is redrawn in place.
 *
 * Correct only because every line a surface writes is cut to `columns - 1`,
 * so one line occupies exactly one row and the count is the arithmetic.
 */
export const clearUp = (rows: number): string => (rows > 0 ? `\x1b[${rows}A${CLEAR_BELOW}` : "");

/**
 * A byte-sequence table as the function that reads one chunk of raw stdin
 * into the keys in it — a paste or a held key arrives as several.
 *
 * The loop is shared; the tables deliberately are not. What a keystroke means
 * is the surface's own business, and the screen and the select disagree about
 * two of them on purpose.
 */
export const decoder =
  <K>(sequences: ReadonlyArray<readonly [string, K]>, unknown: K) =>
  (chunk: string): ReadonlyArray<K> => {
    const keys: Array<K> = [];
    let at = 0;
    while (at < chunk.length) {
      // Longest match first is the table's own ordering, so a lone `Esc` is
      // only read as one after every sequence starting with it is ruled out.
      const found = sequences.find(([bytes]) => chunk.startsWith(bytes, at));
      keys.push(found ? found[1] : unknown);
      at += found ? found[0].length : 1;
    }
    return keys;
  };
