/**
 * What fabrika writes into a pull request it opens, and how that is read back.
 *
 * Two facts travel from the run that opened a pull request to the sweep that
 * finds it weeks later, through nothing but the pull request itself: the
 * identifier in its title, which is the sweep's worktree key and the merge
 * prompt's `identifier` and `title`, and the trailer in its body, which is how
 * a reported line says whose pull request it is. Writer and reader are in
 * different commands, so the format has to be in one place or it drifts —
 * dropping the space after the colon or rewording the trailer breaks a sweep
 * that has no test in the command that broke it.
 *
 * See ADR-0003: a sweep reads the ticket off the pull request because the
 * pull request is all it has.
 */

/** `FAB-5: Conflicted PRs pile up` — the title a run opens its pull request with. */
export const titleOf = (identifier: string, title: string) => `${identifier}: ${title}`;

/**
 * The sentence that marks a pull request as fabrika's. The rest of the trailer
 * is prose that may be reworded; this is the part that is load-bearing, so it
 * is matched on its own.
 */
const MARKER = "Opened by fabrika";

/** The trailer every body fabrika writes ends with. */
export const TRAILER = `${MARKER}. Draft until a human reviews.`;

export const openedByFabrika = (body: string) => body.includes(MARKER);

const TITLED = /^([A-Za-z][A-Za-z0-9]*-\d+)\s*:\s*(.*)$/;

/**
 * A title split back into its identifier and the title itself, or `null` for a
 * title that carries no identifier — a hand-written pull request, which a
 * sweep syncs just as readily under a key of its own.
 */
export const identified = (full: string): { readonly identifier: string; readonly title: string } | null => {
  const titled = TITLED.exec(full);
  return titled ? { identifier: titled[1]!, title: titled[2]! } : null;
};
