import type { RunEvent } from "./run-event.ts";

/**
 * A run as its shape rather than its stream: a root per run, a node per step,
 * and under each node the events that happened while it was open.
 *
 * Pure and terminal-free — no `effect`, no escape sequences, no clock of its
 * own — so the whole of what a screen shows is a function of a scripted event
 * list. `take` is what a presenter calls per event; `outline` is `reduce`
 * over it, for a test or a reader that already has the whole stream.
 */
export type StepState = "pending" | "running" | "done" | "failed" | "skipped" | "already-done";

/** What a finished step came to, folded out of the events that happened inside it. */
export type Summary = {
  readonly seconds?: number;
  readonly usd?: number;
  readonly calls: number;
  /** Descending by count, then by name, so the same events always read the same. */
  readonly tools: ReadonlyArray<{ readonly tool: string; readonly count: number }>;
  /** First-use order, deduplicated. */
  readonly skills: ReadonlyArray<string>;
  readonly gates: ReadonlyArray<{
    readonly name: string;
    readonly state: "pass" | "fail" | "skipped";
    readonly seconds?: number;
  }>;
  /** A skip's reason. */
  readonly reason?: string;
};

/** One event and when it arrived: a window stamps its lines the way scrollback does. */
export type Entry = { readonly at: number; readonly entry: RunEvent | string };

export type Node = {
  /** Unique and stable for the life of a run; the view's selection and fold are keyed by it. */
  readonly key: string;
  readonly name: string;
  /**
   * The step's **position** in the run, not a timestamp — the same pair the
   * `step` event carries. `Entry.at` in this file is a timestamp; these are
   * not. On a root they are the run's own progress: the running step's
   * position, and how many steps there are.
   */
  readonly at: number;
  readonly of: number;
  readonly state: StepState;
  readonly summary: Summary;
  readonly stream: ReadonlyArray<Entry>;
  readonly children: ReadonlyArray<Node>;
};

export type Tree = {
  /** One per run. A list, so a sweep over many pull requests is this tree with more of them. */
  readonly roots: ReadonlyArray<Node>;
  /** Held rather than streamed, so the exit rendering can write it last. */
  readonly result?: Extract<RunEvent, { kind: "result" }>;
};

const noSummary = (): Summary => ({ calls: 0, tools: [], skills: [], gates: [] });

const node = (key: string, name: string, at: number, of: number, state: StepState): Node => ({
  key,
  name,
  at,
  of,
  state,
  summary: noSummary(),
  stream: [],
  children: [],
});

export const empty: Tree = { roots: [] };

/** One event folded in. Returns a new tree and mutates nothing the caller holds. */
export const take = (tree: Tree, _at: number, entry: RunEvent | string): Tree => {
  if (typeof entry === "string") return tree;
  switch (entry.kind) {
    case "run": {
      const index = tree.roots.length;
      const of = entry.steps.length;
      const root: Node = {
        ...node(`${index}`, "", 0, of, "running"),
        // Keyed by position, never by name: a pipeline can hold two steps
        // called `review` and they are two rows.
        children: entry.steps.map((step, at) =>
          node(`${index}:${at + 1}`, step.name, at + 1, of, step.done ? "already-done" : "pending"),
        ),
      };
      return { ...tree, roots: [...tree.roots, root] };
    }
    default:
      return tree;
  }
};

/** The whole stream folded at once, for a reader that has all of it already. */
export const outline = (entries: Iterable<Entry>): Tree => {
  let tree = empty;
  for (const { at, entry } of entries) tree = take(tree, at, entry);
  return tree;
};
