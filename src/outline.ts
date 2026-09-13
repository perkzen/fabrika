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
  /**
   * What the operator calls this run — the ticket identifier. No run event
   * carries it, because an event goes to `log.txt` too and a header field has
   * no business there; the presenter puts it on the tree it starts from.
   */
  readonly label?: string;
  /** Held rather than streamed, so the exit rendering can write it last. */
  readonly result?: Extract<RunEvent, { kind: "result" }>;
  /** The wait the run is inside, if any, for the liveness line. */
  readonly wait?: { readonly subject: string; readonly since: number; readonly deadlineMinutes?: number };
  /**
   * The gate step running now. It carries the command as well as the position,
   * because a running gate's row names what it is on.
   */
  readonly gate?: { readonly name: string; readonly at: number; readonly of: number; readonly command: string };
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
export const take = (tree: Tree, at: number, entry: RunEvent | string): Tree => {
  if (typeof entry === "string") return streamed(tree, { at, entry });
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
    // A step's own events say what state it is in; putting them in its stream
    // would repeat the line they are written under.
    case "step":
      return stepped(tree, entry);
    // Held rather than streamed: the line the piped contract ends on is the
    // one the exit scrollback has to write last, after the whole outline.
    case "result":
      return { ...tree, result: entry };
    // Both are streamed as well as held: they are part of what the step did,
    // and the held copy is only what the liveness row reads.
    case "wait":
      return {
        ...streamed(tree, { at, entry }),
        wait: entry.state === "start" ? { subject: entry.subject, since: at, deadlineMinutes: entry.deadlineMinutes } : undefined,
      };
    case "gate": {
      // Over when it fails or when its last step is behind it — the same rule
      // the scrollback console's live region follows.
      const over = entry.state === "fail" || (entry.at === entry.of && entry.state !== "start");
      return {
        ...streamed(tree, { at, entry }),
        gate: over ? undefined : { name: entry.name, at: entry.at, of: entry.of, command: entry.command },
      };
    }
    default:
      return streamed(tree, { at, entry });
  }
};

/** The whole stream folded at once, for a reader that has all of it already. */
export const outline = (entries: Iterable<Entry>): Tree => {
  let tree = empty;
  for (const { at, entry } of entries) tree = take(tree, at, entry);
  return tree;
};

const stepped = (tree: Tree, entry: Extract<RunEvent, { kind: "step" }>): Tree =>
  inRoot(tree, (root) => ({
    ...root,
    // A step that ended leaves the run's progress where it was: the next
    // `start` is what moves it on.
    at: entry.state === "end" ? root.at : entry.at,
    children: root.children.map((child) => (child.at === entry.at ? restated(child, entry) : child)),
  }));

const restated = (child: Node, entry: Extract<RunEvent, { kind: "step" }>): Node => {
  switch (entry.state) {
    case "start":
      return { ...child, state: "running" };
    case "end":
      return {
        ...child,
        state: entry.outcome === "failed" ? "failed" : "done",
        summary: { ...child.summary, ...(entry.seconds === undefined ? {} : { seconds: entry.seconds }) },
      };
    case "skipped":
      return { ...child, state: "skipped", summary: { ...child.summary, ...(entry.reason ? { reason: entry.reason } : {}) } };
    case "already-done":
      return { ...child, state: "already-done" };
  }
};

/**
 * Attribution is by the open step, never by an event's `stage` field: `stage`
 * is the agent's label for one call and several steps make calls under names
 * of their own, while an event between a step's `start` and its `end` belongs
 * to that step by construction. Before the first start and after the last end
 * there is no open step, and the events are the root's.
 */
const streamed = (tree: Tree, entry: Entry): Tree =>
  inRoot(tree, (root) => {
    const open = root.children.findIndex((child) => child.state === "running");
    if (open < 0) return { ...root, stream: [...root.stream, entry] };
    return {
      ...root,
      children: root.children.map((child, index) =>
        index === open
          ? { ...child, stream: [...child.stream, entry], summary: fold(child.summary, entry.entry) }
          : child,
      ),
    };
  });

/** What one event adds to the step it happened in. Everything else is stream and nothing more. */
const fold = (summary: Summary, entry: RunEvent | string): Summary => {
  if (typeof entry === "string") return summary;
  switch (entry.kind) {
    case "cost":
      return { ...summary, usd: (summary.usd ?? 0) + entry.usd };
    case "tool":
      return {
        ...summary,
        calls: summary.calls + 1,
        tools: counted(summary.tools, entry.tool),
        // The skill the agent reached for is already the call's subject
        // (`describeToolUse` returns `input.skill`), so an invoked skill needs
        // no new event and no new field. A nameless one is no skill.
        skills:
          entry.tool === "Skill" && entry.subject && !summary.skills.includes(entry.subject)
            ? [...summary.skills, entry.subject]
            : summary.skills,
      };
    // A gate's `start` is its liveness, not its verdict; only the three
    // verdicts are what the step came to.
    case "gate":
      return entry.state === "start"
        ? summary
        : {
            ...summary,
            gates: [
              ...summary.gates,
              { name: entry.name, state: entry.state, ...(entry.seconds === undefined ? {} : { seconds: entry.seconds }) },
            ],
          };
    default:
      return summary;
  }
};

/** One more call for that tool, kept in the order a summary reads in. */
const counted = (
  tools: Summary["tools"],
  tool: string,
): Summary["tools"] =>
  (tools.some((seen) => seen.tool === tool)
    ? tools.map((seen) => (seen.tool === tool ? { tool, count: seen.count + 1 } : seen))
    : [...tools, { tool, count: 1 }]
  )
    .slice()
    .sort((a, b) => b.count - a.count || (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));

/** Every fold but `run` changes the last root, which is the run in progress. */
const inRoot = (tree: Tree, change: (root: Node) => Node): Tree => {
  const last = tree.roots.length - 1;
  if (last < 0) return tree;
  return { ...tree, roots: tree.roots.map((root, index) => (index === last ? change(root) : root)) };
};
