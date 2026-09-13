import { styleText } from "node:util";
import { isInteractive, type Style } from "./console.ts";

/**
 * The seven letters, one row per line, in the block font the progress bar
 * already draws with — hand-written rather than pulled from `figlet`, for the
 * same reason the spinner's frames are an array literal: a dependency for
 * fifty-one columns of constant is not worth the lockfile entry.
 */
const ART = [
  "███████╗ █████╗ ██████╗ ██████╗ ██╗██╗  ██╗ █████╗ ",
  "██╔════╝██╔══██╗██╔══██╗██╔══██╗██║██║ ██╔╝██╔══██╗",
  "█████╗  ███████║██████╔╝██████╔╝██║█████╔╝ ███████║",
  "██╔══╝  ██╔══██║██╔══██╗██╔══██╗██║██╔═██╗ ██╔══██║",
  "██║     ██║  ██║██████╔╝██║  ██║██║██║  ██╗██║  ██║",
  "╚═╝     ╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝╚═╝  ╚═╝",
] as const;

/** Every row is cut to the same length, so one number describes the block. */
const WIDTH = ART[0].length;

export type BannerOptions = {
  readonly stream: NodeJS.WriteStream;
  readonly version: string;
  readonly interactive?: boolean;
};

/**
 * The run's nameplate, printed once before anything else it will say.
 *
 * Written straight to the stream rather than through a presenter, and before
 * one exists: a presenter stamps every line with the time and — during a run —
 * mirrors it into `log.txt`, and neither a timestamp nor an archived copy is
 * something six lines of decoration have earned. Writing first also means
 * there is no live region drawn yet for it to walk over.
 *
 * Interactive-only, by the same single verdict the console dresses on: a
 * piped or `CI` run is a log, and a log that opens with block capitals is a
 * log someone has to teach their parser about. A terminal too narrow for the
 * block gets the one-line form, because wrapped ASCII art reads as damage.
 */
export const banner = ({ stream, version, interactive }: BannerOptions): void => {
  if (!(interactive ?? isInteractive(stream))) return;
  const columns = typeof stream.columns === "number" && stream.columns > 1 ? stream.columns : 80;
  const credit = `by perkzen · v${version}`;
  const wordmark: Style = ["bold", "cyan"];
  const block: ReadonlyArray<readonly [Style, string]> =
    columns - 1 < WIDTH
      ? [["dim", `fabrika — ${credit}`]]
      : [...ART.map((row) => [wordmark, row] as const), ["dim", credit.padStart(WIDTH)] as const];
  // Cut before styling, as the console does: a line truncated mid-escape is
  // a corrupt line, and a blank one either side keeps the art off the prompt.
  const lines = block.map(([style, text]) => styleText(style, text.slice(0, columns - 1), { validateStream: false }) + "\n").join("");
  stream.write(`\n${lines}\n`);
};
