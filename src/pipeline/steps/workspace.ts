import { Effect } from "effect";
import { Journal } from "../../ports/journal.ts";
import { RunContext } from "../../ports/run-context.ts";
import { RunStore } from "../../ports/run-store.ts";
import { Workspace } from "../../ports/workspace.ts";
import { installDependencies } from "../install.ts";
import type { Step } from "../step.ts";

/** The tree the rest of the run happens in, and its dependencies. */
export const prepareWorkspace: Step = {
  name: "workspace",
  title: "Workspace",
  about: "git worktree",
  run: Effect.gen(function* () {
    const { config } = yield* RunContext;
    const workspace = yield* Workspace;
    const journal = yield* Journal;
    const store = yield* RunStore;

    yield* workspace.create(store.get().branch!);
    yield* journal.log(`worktree ${workspace.dir}`);
    yield* installDependencies(config.install);
  }),
};
