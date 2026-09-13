import { gateOver, type RunEvent } from "./run-event.ts";

/**
 * A run as its shape rather than its stream: a root per run, a node per step,
 * and under each node the events that happened while it was open.
 *
 * Pure and terminal-free — no `effect`, no escape sequences, no clock of its
 * own — so the whole of what a screen shows is a function of a scripted event
 * list. `take` is what a presenter calls per event; `outline` is `reduce`
 * over it, for a test or a reader that already has the whole stream.
 */

/** How a step's line reads, from the outline's point of view. */
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
export type Entry = { readonly when: number; readonly entry: RunEvent | string };

/** A wait that is still open, as the row animating it reads it. */
export type Wait = { readonly subject: string; readonly since: number; readonly deadlineMinutes?: number };

/**
 * The gate command running now. It carries the command as well as the
 * position, because a running gate's row names what it is on.
 */
export type Gate = { readonly name: string; readonly at: number; readonly of: number; readonly command: string };

export type Node = {
  /** Unique and stable for the life of a run; the view's selection and fold are keyed by it. */
  readonly key: string;
  readonly name: string;
  /** What a row calls the step: the `run` event's title, or the name when it gave none. */
  readonly title: string;
  /** What the step will do, if the `run` event said; a pending row's whole detail. */
  readonly about?: string;
  /**
   * When the step started, or the run did, so a live row can say how long it
   * has been going; unset until it has.
   */
  readonly since?: number;
  /**
   * The step's **position** in the run — the same pair the `step` event
   * carries. On a root they are the run's own progress: the running step's
   * position, and how many steps there are.
   */
  readonly at: number;
  readonly of: number;
  readonly state: StepState;
  readonly summary: Summary;
  readonly stream: ReadonlyArray<Entry>;
  readonly children: ReadonlyArray<Node>;
  /**
   * The waits open in this node, oldest first, and the gate it is inside.
   *
   * Per node rather than per tree because a sweep has six of each at once and
   * a single field would have them blanking each other: `wait end` clears the
   * wait whichever wait ended, so the row still waiting would go quiet while
   * it was still waiting. A run has one open step and so at most one of each,
   * and reads exactly as it did.
   */
  readonly waits: ReadonlyArray<Wait>;
  readonly gate?: Gate;
  /**
   * Where this row's tree is, absolute. No run event carries it — see
   * `Tree.worktree` — so the presenter puts it on the node it hands out, which
   * is what `o` opens and what a sweep has one of per row.
   */
  readonly worktree?: string;
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
  /**
   * Where this run's worktree is, absolute. No run event carries it either,
   * and for `label`'s reason: it is a fact about this machine, and an event
   * goes to `log.txt` too.
   */
  readonly worktree?: string;
  /** Held rather than streamed, so the exit rendering can write it last. */
  readonly result?: Extract<RunEvent, { kind: "result" }>;
  /**
   * Whether this tree's rows have writers of their own — set by `bound`, and
   * true for a sweep and false for a run.
   *
   * It decides where an event with no address goes. A run has one open step
   * and its events are that step's; a sweep's rows are written to through
   * presenters of their own, so anything arriving unaddressed is the sweep's
   * own line and belongs to no row — not even when exactly one worker happens
   * to still be running, which is the case a "one open step" rule gets wrong.
   */
  readonly addressed?: boolean;
};

const noSummary = (): Summary => ({ calls: 0, tools: [], skills: [], gates: [] });

const node = (key: string, name: string, title: string, at: number, of: number, state: StepState): Node => ({
  key,
  name,
  title,
  at,
  of,
  state,
  summary: noSummary(),
  stream: [],
  children: [],
  waits: [],
});

export const empty: Tree = { roots: [] };

/**
 * The steps of the run in progress — the last root's children, and an empty
 * list before the first `run` event. Every surface asks the tree this, so it
 * is asked in one place.
 */
export const steps = (tree: Tree): ReadonlyArray<Node> => tree.roots.at(-1)?.children ?? [];

/**
 * One event folded in. Returns a new tree and mutates nothing the caller holds.
 *
 * `address` is the name of the node the event belongs to, for the one caller
 * that knows: a sweep hands each worker a presenter bound to its row, because
 * six workers are six running steps and "the open step" would send five of
 * them to the wrong window. A run addresses nothing and is attributed the way
 * it always was.
 */
export const take = (tree: Tree, when: number, entry: RunEvent | string, address?: string): Tree => {
  if (typeof entry === "string") return streamed(tree, { when, entry }, address);
  switch (entry.kind) {
    case "run": {
      const index = tree.roots.length;
      const of = entry.steps.length;
      const root: Node = {
        ...node(`${index}`, "", "", 0, of, "running"),
        since: when,
        // Keyed by position, never by name: a pipeline can hold two steps
        // called `review` and they are two rows.
        children: entry.steps.map((step, at) => ({
          ...node(`${index}:${at + 1}`, step.name, step.title ?? step.name, at + 1, of, step.done ? "already-done" : "pending"),
          ...(step.about === undefined ? {} : { about: step.about }),
        })),
      };
      return { ...tree, roots: [...tree.roots, root] };
    }
    // A step's own events say what state it is in; putting them in its stream
    // would repeat the line they are written under.
    case "step":
      return stepped(tree, when, entry);
    // Held rather than streamed: the line the piped contract ends on is the
    // one the exit scrollback has to write last, after the whole outline.
    case "result":
      return { ...tree, result: entry };
    // Both are streamed as well as held: they are part of what the step did,
    // and the held copy is only what the row's liveness reads.
    case "wait":
      return waited(streamed(tree, { when, entry }, address), when, entry, address);
    case "gate":
      return addressed(streamed(tree, { when, entry }, address), address, (target) => ({
        ...target,
        gate: gateOver(entry) ? undefined : { name: entry.name, at: entry.at, of: entry.of, command: entry.command },
      }));
    default:
      return streamed(tree, { when, entry }, address);
  }
};

/**
 * One row handed to a writer of its own, and where that writer works.
 *
 * The worktree is told rather than emitted, for `Tree.worktree`'s reason one
 * row down: an event goes to that worker's `log.txt` too, and a path this
 * machine chose is no business of the record. Binding is also what makes the
 * tree `addressed` — see the field.
 *
 * A name that names no row still binds the tree: the presenter binds a row
 * before that row's work starts, and getting the name wrong must not silently
 * turn a sweep back into a run.
 */
export const bound = (tree: Tree, name: string, worktree?: string): Tree =>
  inRoot({ ...tree, addressed: true }, (root) => ({
    ...root,
    children: root.children.map((child) => (child.name === name && worktree !== undefined ? { ...child, worktree } : child)),
  }));

/** Whether anything in the tree is still waiting on something — what a surface animates for. */
export const waiting = (tree: Tree): boolean => {
  const root = tree.roots.at(-1);
  if (!root) return false;
  return root.waits.length > 0 || root.children.some((child) => child.waits.length > 0);
};

/**
 * A wait opened or closed in the node it happened in.
 *
 * An `end` clears the first wait with that subject, and falls back to the root
 * when the node it is addressed to has none — a wait can open before the step
 * that ends it started, and the sweep's own fan-out wait is exactly that.
 */
const waited = (tree: Tree, when: number, entry: Extract<RunEvent, { kind: "wait" }>, address: string | undefined): Tree => {
  if (entry.state === "start") {
    const wait: Wait = { subject: entry.subject, since: when, deadlineMinutes: entry.deadlineMinutes };
    return addressed(tree, address, (target) => ({ ...target, waits: [...target.waits, wait] }));
  }
  const held = (node: Node) => node.waits.some((wait) => wait.subject === entry.subject);
  const without = (node: Node): Node => {
    const at = node.waits.findIndex((wait) => wait.subject === entry.subject);
    return at < 0 ? node : { ...node, waits: [...node.waits.slice(0, at), ...node.waits.slice(at + 1)] };
  };
  const target = nodeOf(tree, address);
  return target && held(target)
    ? addressed(tree, address, without)
    : inRoot(tree, (root) => (held(root) ? without(root) : root));
};

/** One event as a caller hands it over: the entry, when it arrived, and the row it belongs to. */
export type Scripted = Entry & { readonly address?: string };

/** The whole stream folded at once, for a reader that has all of it already. */
export const outline = (entries: Iterable<Scripted>): Tree => {
  let tree = empty;
  for (const { when, entry, address } of entries) tree = take(tree, when, entry, address);
  return tree;
};

const stepped = (tree: Tree, when: number, entry: Extract<RunEvent, { kind: "step" }>): Tree =>
  inRoot(tree, (root) => ({
    ...root,
    // A step that ended leaves the run's progress where it was: the next
    // `start` is what moves it on.
    at: entry.state === "end" ? root.at : entry.at,
    children: root.children.map((child) => (child.at === entry.at ? restated(child, when, entry) : child)),
  }));

const restated = (child: Node, when: number, entry: Extract<RunEvent, { kind: "step" }>): Node => {
  switch (entry.state) {
    case "start":
      return { ...child, state: "running", since: when };
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
 * Attribution is by address when there is one and by the open step otherwise,
 * never by an event's `stage` field: `stage` is the agent's label for one call
 * and several steps make calls under names of their own, while an event
 * between a step's `start` and its `end` belongs to that step by construction.
 *
 * With no address the event is the open step's on a run and the root's on a
 * sweep, where every row has a writer of its own and an unaddressed line is
 * therefore about the sweep rather than about whichever worker happens still
 * to be running. Before the first start and after the last end there is no
 * open step, and those events are the root's either way.
 */
const streamed = (tree: Tree, entry: Entry, address?: string): Tree =>
  addressed(tree, address, (target) => ({
    ...target,
    stream: [...target.stream, entry],
    summary: fold(target.summary, entry.entry),
  }));

/** The node an event is attributed to, or nothing when the tree has no root yet. */
const nodeOf = (tree: Tree, address: string | undefined): Node | undefined => {
  const root = tree.roots.at(-1);
  if (!root) return undefined;
  if (address !== undefined) return root.children.find((child) => child.name === address) ?? root;
  if (tree.addressed) return root;
  const open = root.children.filter((child) => child.state === "running");
  return open.length === 1 ? open[0]! : root;
};

/** One change applied to whichever node the event is attributed to. */
const addressed = (tree: Tree, address: string | undefined, change: (node: Node) => Node): Tree => {
  const target = nodeOf(tree, address);
  if (!target) return tree;
  return inRoot(tree, (root) =>
    root === target ? change(root) : { ...root, children: root.children.map((child) => (child === target ? change(child) : child)) },
  );
};

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
