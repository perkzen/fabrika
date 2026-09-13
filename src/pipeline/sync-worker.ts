/**
 * One pull request's share of a sweep: its own worktree, run directory, gate
 * and agent session, run alongside a bounded number of others.
 *
 * Its own module because it is the only part of a sweep that touches a
 * repository. What is around it — which pull requests get one, what the
 * operator is told — is decided without a tree, a gate or an agent anywhere
 * near it.
 */
import { Effect } from "effect";
import { Journal } from "../ports/journal.ts";
import { Workspace } from "../ports/workspace.ts";
import { installDependencies } from "./install.ts";
import type { StepError } from "./step.ts";
import { syncWithBase, type SyncServices } from "./sync.ts";
import type { SyncTarget } from "./sweep-selection.ts";

/**
 * It fails the way every other step fails — the sweep is the one place that
 * turns that into a value — and it removes its tree only on the way out
 * clean, so an escalation leaves exactly what an escalated run leaves.
 *
 * No review rounds and no forge call: the reviewer has already ruled on this
 * branch, and a merge commit is not a new implementation.
 */
export const syncPullRequest = (
  target: SyncTarget,
): Effect.Effect<{ readonly pushed: string | null }, StepError, SyncServices> =>
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    const journal = yield* Journal;

    yield* workspace.checkout(target.branch);
    yield* journal.log(`worktree ${workspace.dir}`);
    yield* installDependencies(target.install);

    // Read after `checkout` has fetched, so the key names the tip actually
    // being merged: it changes exactly when the thing being merged changes.
    const base = yield* workspace.baseSha;
    const moved = yield* syncWithBase({ prUrl: target.url, session: `sync-${base.slice(0, 7)}` });
    if (!moved) {
      yield* workspace.remove;
      return { pushed: null };
    }
    const head = yield* workspace.push(target.branch);
    yield* workspace.remove;
    return { pushed: head };
  });
