import { appendFileSync } from "node:fs";
import type { Presenter } from "./surface.ts";
import { plain, stamp, type RunEvent } from "../domain/run-event.ts";

export type ArchiveOptions = {
  /** The run's own `log.txt`. Appended to, never truncated: a resumed run continues it. */
  readonly file: string;
  readonly now?: () => number;
};

/**
 * The presenter for `log.txt` — the run's uncapped, ANSI-free copy of itself.
 *
 * The plain rendering, stamped on every physical line, so the file stays
 * greppable and a multi-line agent message stays line-oriented. Agent speech
 * arrives as the markdown it was written in: `- item` renders where `• item`
 * does not, and a run gets pasted into issues.
 *
 * `appendFileSync` rather than the FileSystem service on purpose: `show` has
 * to stay callable from the agent's stream-json callback, which is a plain
 * function. A line that cannot be written is dropped rather than failing the
 * run — the console has it either way.
 *
 * `end` is a no-op: this surface has no cursor to restore and no timer to
 * disarm. It is here because the journal closes every surface the same way.
 */
export const openArchive = (options: ArchiveOptions): Presenter => {
  const now = options.now ?? Date.now;
  return {
    show: (entry: RunEvent | string) => {
      try {
        for (const line of plain(entry)) appendFileSync(options.file, `${stamp(now())} ${line}\n`);
      } catch {}
    },
    end: () => {},
  };
};
