import { Effect } from "effect";
import { Journal } from "../../ports/journal.ts";
import { RunContext } from "../../ports/run-context.ts";
import { RunStore } from "../../ports/run-store.ts";
import { Workspace } from "../../ports/workspace.ts";
import type { Step } from "../step.ts";

/** The tree the rest of the run happens in, and its dependencies. */
export const prepareWorkspace: Step = {
  name: "workspace",
  run: Effect.gen(function* () {
    const { config } = yield* RunContext;
    const workspace = yield* Workspace;
    const journal = yield* Journal;
    const store = yield* RunStore;

    yield* workspace.create(store.get().branch!);
    yield* journal.log(`worktree ${workspace.dir}`);

    if (config.install) {
      const started = Date.now();
      yield* journal.log(`install: ${config.install}`);
      const installed = yield* workspace.install(config.install);
      yield* journal.log(
        installed ? `install: ok (${((Date.now() - started) / 1000).toFixed(0)}s)` : `install: skipped (already present)`,
      );
    }
  }),
};
