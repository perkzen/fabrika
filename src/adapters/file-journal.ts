import { Effect, Layer } from "effect";
import { basename } from "node:path";
import { openArchive } from "../infra/archive.ts";
import { openConsole, type ConsoleOptions } from "../infra/console.ts";
import { Journal } from "../ports/journal.ts";
import type { RunEvent } from "../run-event.ts";

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
 * `null` is the archive alone, for a sweep's workers: the sweep owns the only
 * console, and a presenter over a discarding stream would still build a live
 * region, a frame timer and a cursor hide for nobody. It is tested with
 * `=== null` rather than `??`, because `null ?? default` is the default — six
 * workers would each open a console on stdout and fight over it.
 */
export const layer = (file: string, consoleOptions?: ConsoleOptions | null) =>
  Layer.effect(Journal)(
    Effect.gen(function* () {
      // The label, not the path: the elision line points at `log.txt`, which is
      // what the operator calls it, not a line of absolute path.
      const options = consoleOptions === null ? null : (consoleOptions ?? { stream: process.stdout, archive: basename(file) });
      const surfaces = [
        ...(options ? [openConsole(options)] : []),
        openArchive({ file, now: options?.now }),
      ];
      // The layer owns their lifetime: the live region is cleared and the
      // cursor restored before `cli.ts` writes anything to stderr.
      yield* Effect.addFinalizer(() => Effect.sync(() => surfaces.forEach((surface) => surface.end())));
      const write = (entry: RunEvent | string) => surfaces.forEach((surface) => surface.show(entry));
      return { write, log: (entry: RunEvent | string) => Effect.sync(() => write(entry)) };
    }),
  );
