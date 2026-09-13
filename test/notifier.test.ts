import assert from "node:assert/strict";
import { test } from "node:test";
import { openNotifier } from "../src/infra/notifier.ts";

const posted = () => {
  const calls: Array<[string, string]> = [];
  return { calls, post: (text: string, title: string) => void calls.push([text, title]) };
};

test("the outcome is posted once, marked, when the run is over rather than when it is decided", () => {
  const { calls, post } = posted();
  const notifier = openNotifier({ title: "Fabrika PAR-12", post });

  notifier.show({ kind: "run", steps: [], completed: [] });
  notifier.show({ kind: "result", outcome: "done", text: "done: checks green — ready for human review: https://x.test/1" });
  assert.deepEqual(calls, [], "a decided run is still a running one until the surfaces close");

  notifier.end();
  assert.deepEqual(calls, [["done: checks green — ready for human review: https://x.test/1", "\u2705 Fabrika PAR-12"]]);

  notifier.end();
  assert.equal(calls.length, 1, "and a layer released twice does not say it twice");
});

test("an escalation is the same path, because it is the same event", () => {
  const { calls, post } = posted();
  const notifier = openNotifier({ title: "Fabrika PAR-12", post });
  notifier.show({ kind: "run", steps: [], completed: [] });
  notifier.show({ kind: "result", outcome: "escalated", text: "escalated: gate failed 4 times" });
  notifier.end();
  assert.deepEqual(calls, [["escalated: gate failed 4 times", "\u26A0\uFE0F Fabrika PAR-12"]]);
});

test("a run that stops with no outcome of its own still reports — that is the usage limit and the crash", () => {
  const { calls, post } = posted();
  const notifier = openNotifier({ title: "Fabrika PAR-12", post });
  notifier.show({ kind: "run", steps: [], completed: [] });
  notifier.show({ kind: "step", name: "implement", at: 3, of: 6, state: "start" });
  notifier.end();
  assert.deepEqual(calls, [["stopped before finishing — see the terminal", "\uD83D\uDED1 Fabrika PAR-12"]]);
});

test("a rerun of a finished ticket never starts, so nothing is posted", () => {
  const { calls, post } = posted();
  const notifier = openNotifier({ title: "Fabrika PAR-12", post });
  // What `runTicket` emits when it short-circuits: a bare string, before the
  // pipeline has emitted the `run` event that arms this.
  notifier.show("already done: PAR-12 — remove ~/.fabrika/runs/... to rerun");
  notifier.end();
  assert.deepEqual(calls, []);
});

test("a machine with no bundle posts nothing at all, rather than posting as something else", () => {
  const { calls, post } = posted();
  assert.equal(post.length, 2, "the injected poster is the only reason this file never spawns");

  // No `bin`, no injected `post`: the surface is inert rather than falling
  // back to a notification wearing another app's name.
  const notifier = openNotifier({ title: "Fabrika PAR-12" });
  notifier.show({ kind: "run", steps: [], completed: [] });
  notifier.show({ kind: "result", outcome: "done", text: "done: ready for human review" });
  assert.doesNotThrow(() => notifier.end());
  assert.deepEqual(calls, []);
});
