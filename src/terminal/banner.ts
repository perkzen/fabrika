import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isInteractive, sizeOf, styler, type Style } from "./surface.ts";

/**
 * The version on the nameplate, read rather than hard-coded: the two drifted
 * once already, and `npm version` only bumps package.json and the plugin
 * manifest. It lives beside the banner because the banner is what shows it,
 * and because a rehearsal prints the same nameplate a run does.
 */
export const VERSION = ((): string => {
  const pkg: unknown = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"));
  return typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string" ? pkg.version : "0.0.0";
})();

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
  const { columns } = sizeOf(stream);
  const credit = `by perkzen · v${version}`;
  // White, so the nameplate is the plainest thing on the screen and the
  // colour is spent on what the run is doing: the select's chip under it,
  // and the outline's own cyan for whatever is happening now.
  const wordmark: Style = ["bold", "white"];
  const block: ReadonlyArray<readonly [Style, string]> =
    columns - 1 < WIDTH
      ? [["dim", `fabrika — ${credit}`]]
      : [...ART.map((row) => [wordmark, row] as const), ["dim", credit.padStart(WIDTH)] as const];
  // Cut before styling, as the console does: a line truncated mid-escape is
  // a corrupt line, and a blank one either side keeps the art off the prompt.
  const dress = styler(true);
  const lines = block.map(([style, text]) => dress(style, text.slice(0, columns - 1)) + "\n").join("");
  stream.write(`\n${lines}\n`);
};
