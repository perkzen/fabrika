import { Effect, Layer } from "effect";
import { appendFileSync } from "node:fs";
import { openConsole } from "../infra/console.ts";
import { Journal } from "../ports/journal.ts";
import { plain, type RunEvent } from "../run-event.ts";

const stamp = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

/**
 * The operator's console, mirrored to the run's own log file.
 *
 * The file always gets the plain rendering, stamped on every physical line,
 * so it stays greppable and a multi-line agent message stays line-oriented.
 * The console gets the same events through a presenter, which is free to
 * dress them differently.
 *
 * `appendFileSync` rather than the FileSystem service on purpose: `write` has
 * to stay callable from the agent's stream-json callback, which is a plain
 * function. A log line that cannot be written is dropped rather than failing
 * the run — the console has it either way.
 */
export const layer = (file: string) =>
  Layer.effect(Journal)(
    Effect.gen(function* () {
      const presenter = openConsole({ stream: process.stdout });
      // The layer owns the presenter's lifetime: the live region is cleared
      // and the cursor restored before `cli.ts` writes anything to stderr.
      yield* Effect.addFinalizer(() => Effect.sync(presenter.end));
      const write = (entry: RunEvent | string) => {
        presenter.show(entry);
        try {
          for (const line of plain(entry)) appendFileSync(file, `${stamp()} ${line}\n`);
        } catch {}
      };
      return { write, log: (entry: RunEvent | string) => Effect.sync(() => write(entry)) };
    }),
  );
