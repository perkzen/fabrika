import { Effect, Layer } from "effect";
import { basename } from "node:path";
import { openArchive } from "../terminal/archive.ts";
import { openConsole } from "../terminal/console.ts";
import { openScreen } from "../terminal/screen.ts";
import { isInteractive, type Presenter } from "../terminal/surface.ts";
import { Journal } from "../ports/journal.ts";
import type { RunEvent } from "../domain/run-event.ts";

/**
 * The fan-out every form shares.
 *
 * The surfaces are built inside the effect rather than by the caller: opening
 * a console attaches a SIGINT handler and hides a cursor, and a layer that is
 * never provided must not have done either.
 */
const journal = (surfaces: () => ReadonlyArray<Presenter>) =>
  Layer.effect(Journal)(
    Effect.gen(function* () {
      const open = surfaces();
      // The layer owns their lifetime: the live region is cleared and the
      // cursor restored before `cli.ts` writes anything to stderr.
      yield* Effect.addFinalizer(() => Effect.sync(() => open.forEach((surface) => surface.end())));
      const write = (entry: RunEvent | string) => open.forEach((surface) => surface.show(entry));
      return { write, log: (entry: RunEvent | string) => Effect.sync(() => write(entry)) };
    }),
  );

export type RunJournal = {
  /** The run's own `log.txt`, absolute. The archive gets the path; the console is told only its name. */
  readonly archive: string;
  /** What a screen's header calls this run. */
  readonly ticket?: string;
  /** The run's worktree, absolute: the row a screen draws and the line every exit prints. */
  readonly worktree?: string;
  /** Defaults to `process.stdout`. */
  readonly stream?: NodeJS.WriteStream;
  /** Where keys come from. A run whose operator is not there gets a screen with no keys. */
  readonly input?: NodeJS.ReadStream;
  /** What `o` does, already bound to the worktree; its presence is what puts the key in the keys row. */
  readonly open?: () => void;
  readonly now?: () => number;
  /** States the verdict instead of making it, for a test that wants one or the other. */
  readonly interactive?: boolean;
  /** A surface the composition root decided on. */
  readonly extra?: ReadonlyArray<Presenter>;
};

/**
 * The operator's console, mirrored to the run's own log file.
 *
 * Which surface an interactive run gets is decided here, once. A run an
 * operator is watching gets the screen; a pipe, `NO_COLOR`, `TERM=dumb` and
 * CI get the scrollback console — the same single verdict the console dresses
 * on, because a run is either fully dressed or fully plain. It lives here
 * rather than in each composition root because the roots disagreeing about it
 * is exactly the drift this replaces: a rehearsal is the real run's surface
 * or it is rehearsing nothing.
 *
 * Nothing here renders anything: every surface is a presenter and this is the
 * fan-out across them. They share one clock, so the file and the console never
 * disagree about when the same event happened.
 */
export const layer = (options: RunJournal) =>
  journal(() => {
    const stream = options.stream ?? process.stdout;
    const shared = {
      stream,
      now: options.now,
      interactive: options.interactive,
      // The label, not the path: the elision line points at `log.txt`, which
      // is what the operator calls it, not a line of absolute path.
      archive: basename(options.archive),
      worktree: options.worktree,
    };
    const watched = options.interactive ?? isInteractive(stream);
    return [
      watched ? openScreen({ ...shared, ticket: options.ticket, input: options.input, open: options.open }) : openConsole(shared),
      openArchive({ file: options.archive, now: options.now }),
      ...(options.extra ?? []),
    ];
  });

export type ConsoleJournal = {
  readonly stream?: NodeJS.WriteStream;
  readonly now?: () => number;
  readonly interactive?: boolean;
};

/**
 * One scrollback console and nothing else — a sweep, which owns the only
 * console over every worker, and `init`, which has no run directory to mirror
 * into.
 *
 * A form of its own rather than an option, for the reason `archiveOnly` is
 * one: the surfaces a journal has are few and named, and a caller that spells
 * them out is a caller that cannot get them by accident. Never a screen,
 * whatever the terminal is: neither of these two draws an outline.
 */
export const consoleOnly = (options: ConsoleJournal = {}) =>
  journal(() => [openConsole({ stream: options.stream ?? process.stdout, now: options.now, interactive: options.interactive })]);

/**
 * The archive by itself, for a sweep's worker: the sweep owns the only
 * console, and a presenter over a discarding stream would still build a live
 * region, a frame timer and a cursor hide for nobody.
 */
export const archiveOnly = (file: string) => journal(() => [openArchive({ file })]);
