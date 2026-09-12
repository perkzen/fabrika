import { Effect, Layer } from "effect";
import { appendFileSync } from "node:fs";
import { Journal } from "../ports/journal.ts";

const stamp = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

/**
 * The operator's console, mirrored to the run's own log file.
 *
 * `appendFileSync` rather than the FileSystem service on purpose: `write` has
 * to stay callable from the agent's stream-json callback, which is a plain
 * function. A log line that cannot be written is dropped rather than failing
 * the run — the console has it either way.
 */
export const layer = (file: string) =>
  Layer.sync(Journal)(() => {
    const write = (line: string) => {
      const stamped = `${stamp()} ${line}`;
      console.log(stamped);
      try {
        appendFileSync(file, stamped + "\n");
      } catch {}
    };
    return { write, log: (line: string) => Effect.sync(() => write(line)) };
  });
