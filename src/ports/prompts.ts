import { Context, type Effect } from "effect";
import type { FabrikaError } from "../errors.ts";

/**
 * The prompt files a stage is made of, with the run's variables already
 * filled in. A caller names a file and gets text; where prompts live and
 * which `{{placeholders}}` a run defines are not its problem.
 *
 * `file` hands back an absolute path instead, for the one flag that wants a
 * file rather than its contents (`--append-system-prompt-file`), and `exists`
 * is what lets a run fail on a missing prompt before it spends an install.
 */
export interface Prompts {
  readonly render: (file: string, extra?: Record<string, string>) => Effect.Effect<string, FabrikaError>;
  readonly file: (name: string) => string;
  readonly exists: (name: string) => Effect.Effect<boolean, FabrikaError>;
  /** Adds or replaces a run variable, e.g. the branch once it is chosen. */
  readonly define: (name: string, value: string) => void;
}

export const Prompts = Context.Service<Prompts>("Prompts");
