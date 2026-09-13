import { Effect, Layer } from "effect";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { openConsole, type ConsoleOptions } from "../infra/console.ts";
import { Journal } from "../ports/journal.ts";
import { plain, type RunEvent } from "../run-event.ts";

/**
 * The operator's console, mirrored to the run's own log file.
 *
 * The file always gets the plain rendering, stamped on every physical line,
 * so it stays greppable and a multi-line agent message stays line-oriented.
 * The console gets the same events through a presenter, which is free to
 * dress them differently — and for agent speech it does.
 *
 * `appendFileSync` rather than the FileSystem service on purpose: `write` has
 * to stay callable from the agent's stream-json callback, which is a plain
 * function. A log line that cannot be written is dropped rather than failing
 * the run — the console has it either way.
 */
export const layer = (file: string, console_?: ConsoleOptions) =>
  Layer.effect(Journal)(
    Effect.gen(function* () {
      // The label, not the path: the elision line points at `log.txt`, which is
      // what the operator calls it, not a line of absolute path.
      const options = console_ ?? { stream: process.stdout, archive: basename(file) };
      const presenter = openConsole(options);
      // One clock for both surfaces, so the file and the console never
      // disagree about when the same event happened.
      const now = options.now ?? Date.now;
      const stamp = () => new Date(now()).toLocaleTimeString("en-GB", { hour12: false });
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
