import { Effect, Layer } from "effect";
import { basename } from "node:path";
import { openArchive } from "../terminal/archive.ts";
import { openConsole, type ConsoleOptions, type Presenter } from "../terminal/console.ts";
import { Journal } from "../ports/journal.ts";
import type { RunEvent } from "../domain/run-event.ts";

/** The fan-out both forms share; `null` builds the archive alone. */
const journal = (
  file: string,
  consoleOptions: ConsoleOptions | null,
  extra: ReadonlyArray<Presenter> = [],
  open: (options: ConsoleOptions) => Presenter = openConsole,
) =>
  Layer.effect(Journal)(
    Effect.gen(function* () {
      const surfaces = [
        ...(consoleOptions ? [open(consoleOptions)] : []),
        openArchive({ file, now: consoleOptions?.now }),
        ...extra,
      ];
      // The layer owns their lifetime: the live region is cleared and the
      // cursor restored before `cli.ts` writes anything to stderr.
      yield* Effect.addFinalizer(() => Effect.sync(() => surfaces.forEach((surface) => surface.end())));
      const write = (entry: RunEvent | string) => surfaces.forEach((surface) => surface.show(entry));
      return { write, log: (entry: RunEvent | string) => Effect.sync(() => write(entry)) };
    }),
  );

/**
 * The operator's console, mirrored to the run's own log file.
 *
 * Nothing here renders anything: every surface is a presenter and this is the
 * fan-out across them. The two differ in what they do with the same event —
 * the console dresses it, caps agent speech and animates an open wait; the
 * archive keeps it plain and uncapped — and neither has to know the other
 * exists. A third surface is another presenter in the list.
 *
 * They share one clock, so the file and the console never disagree about when
 * the same event happened.
 *
 * `extra` is how a run adds one it decided on. Which surfaces exist is the
 * composition root's call, not this layer's: it only fans out to whatever it
 * was given.
 *
 * `open` is which console it is: the scrollback one, or the screen an
 * interactive run gets. A parameter rather than a different `consoleOptions`
 * type, so this layer keeps building the shared clock and the archive label
 * and every existing call site is untouched.
 */
export const layer = (
  file: string,
  consoleOptions?: ConsoleOptions,
  extra: ReadonlyArray<Presenter> = [],
  open: (options: ConsoleOptions) => Presenter = openConsole,
) =>
  // The label, not the path: the elision line points at `log.txt`, which is
  // what the operator calls it, not a line of absolute path.
  journal(file, consoleOptions ?? { stream: process.stdout, archive: basename(file) }, extra, open);

/**
 * The archive by itself, for a sweep's worker: the sweep owns the only
 * console, and a presenter over a discarding stream would still build a live
 * region, a frame timer and a cursor hide for nobody.
 *
 * A second operation beside `layer` rather than a state of its argument. As an
 * argument it was a `null` that had to be read before `??` reached it, and the
 * default `??` gives is a console on stdout — so the mistake six workers can
 * least afford was the one a careless edit would make.
 */
export const archiveOnly = (file: string) => journal(file, null);
