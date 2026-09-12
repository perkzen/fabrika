import { Effect, FileSystem, Layer, Path } from "effect";
import { asFabrikaError } from "../errors.ts";
import { PROMPTS_DIR } from "../paths.ts";
import { Prompts } from "../ports/prompts.ts";

/** `{{name}}`; an undefined variable renders as nothing rather than as itself. */
const fill = (template: string, vars: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");

/**
 * The prompt files fabrika ships, filled from one set of run variables that
 * grows as the run learns things — the branch is defined once it is chosen,
 * and every prompt rendered afterwards sees it.
 */
export const layer = (vars: Record<string, string>) =>
  Layer.effect(Prompts)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = (name: string) => path.join(PROMPTS_DIR, name);
      return {
        file,
        exists: (name: string) => fs.exists(file(name)).pipe(Effect.mapError(asFabrikaError(`reading ${PROMPTS_DIR}`))),
        define: (name: string, value: string) => {
          vars[name] = value;
        },
        render: (name: string, extra: Record<string, string> = {}) =>
          fs
            .readFileString(file(name))
            .pipe(Effect.map((text) => fill(text, { ...vars, ...extra })), Effect.mapError(asFabrikaError(`reading prompts/${name}`))),
      } satisfies Prompts;
    }),
  );
