import assert from "node:assert/strict";
import { test } from "node:test";
import type { Shot } from "../src/domain/captures.ts";
import { openPullRequest } from "../src/pipeline/steps/pull-request.ts";
import { exercise } from "./harness.ts";

/** The harness reports `src/a.ts` as changed, so these globs match and `docs/**` does not. */
const console_ = { name: "console", run: "node scripts/capture-console.ts", when: ["src/**"] };

const BEFORE = "/runs/FAB-1/captures/console/before/frame.png";
const AFTER = "/runs/FAB-1/captures/console/after/frame.png";

const framed: Shot = {
  capture: "console",
  before: [{ name: "frame.png", kind: "image", content: BEFORE }],
  after: [{ name: "frame.png", kind: "image", content: AFTER }],
};

/** Every `(…)` target in the body that is an absolute path on this machine. */
const hostPaths = (body: string) => [...body.matchAll(/\((\/[^\s)]+)\)/g)].map((match) => match[1]!);

test("a matching capture puts the section in the body and its images on the pull request", async () => {
  const { failed, recording } = await exercise(openPullRequest.run, {
    config: { pr: { draft: true, emptyCommit: false, capture: [console_] } },
    captures: [framed],
  });

  assert.equal(failed, false);
  const pr = recording.prs[0]!;

  const description = pr.body.indexOf("the description");
  const section = pr.body.indexOf("## Before / After");
  const trailer = pr.body.indexOf("\n---\n");
  assert.ok(section > description, "the section follows the description");
  assert.ok(section < trailer, "the section precedes the trailer");

  assert.deepEqual([...pr.attachments].sort(), [AFTER, BEFORE], "both halves are uploaded with the pull request");
  assert.deepEqual(
    new Set(hostPaths(pr.body)),
    new Set(pr.attachments),
    "every attachment is referenced by the body and the body points at nothing else on this host",
  );

  assert.deepEqual(recording.captures, [{ name: "console", sha: "a1b2c3d4e5f6" }], "asked for the base the PR is diffed against");
});

/** Written out from the step as it stood before captures existed, not from `composeBody`. */
const TODAYS_BODY = "\n\nthe description\n\n---\nOpened by fabrika. Draft until a human reviews.";

test("a run with nothing to show is the run there is today", async () => {
  // No `pr.capture` at all — the upgrade path — and one whose globs miss.
  const scripts = [
    {},
    { config: { pr: { draft: true, emptyCommit: true, capture: [{ ...console_, when: ["docs/**"] }] } } },
  ];

  for (const script of scripts) {
    const { failed, recording } = await exercise(openPullRequest.run, { ...script, captures: [framed] });
    assert.equal(failed, false);
    assert.equal(recording.prs[0]!.body, TODAYS_BODY);
    assert.deepEqual(recording.prs[0]!.attachments, []);
    assert.deepEqual(recording.captures, [], "nothing was asked for, so no command ran");
  }
});

const texted: Shot = {
  capture: "console",
  before: [{ name: "out.txt", kind: "text", content: "old" }],
  after: [{ name: "out.txt", kind: "text", content: "new" }],
};

const withCapture = { config: { pr: { draft: true, emptyCommit: true, capture: [console_] } } };

test("an old gh drops the images and keeps the text", async () => {
  const images = await exercise(openPullRequest.run, { ...withCapture, captures: [framed], attaches: false });
  assert.equal(images.recording.prs[0]!.body, TODAYS_BODY, "an image-only capture leaves the body as it is today");
  assert.deepEqual(images.recording.prs[0]!.attachments, []);

  const words = await exercise(openPullRequest.run, { ...withCapture, captures: [texted], attaches: false });
  assert.ok(words.recording.prs[0]!.body.includes("## Before / After"), "a text capture still gets its section");
  assert.deepEqual(words.recording.prs[0]!.attachments, []);
});

test("an upload that fails opens the pull request without it", async () => {
  const retried = await exercise(openPullRequest.run, {
    ...withCapture,
    captures: [framed],
    open: "fails-with-attachments",
  });

  assert.equal(retried.failed, false, "a rejected upload does not fail the run");
  assert.equal(retried.recording.prs.length, 2);
  assert.deepEqual(retried.recording.prs[0]!.attachments, [BEFORE, AFTER], "the first attempt carried them");
  assert.equal(retried.recording.prs[1]!.body, TODAYS_BODY, "the second is today's body exactly");
  assert.deepEqual(retried.recording.prs[1]!.attachments, []);
  assert.ok(
    retried.recording.log.some((line) => line.includes("attachment rejected")),
    "the reason is in the journal",
  );
  assert.equal(retried.recording.state().prNumber, 7);
  assert.deepEqual(retried.recording.edited, [], "the fallback body has no host path in it, so the read-back changes nothing");

  const dead = await exercise(openPullRequest.run, { ...withCapture, captures: [framed], open: "fails" });
  assert.equal(dead.failed, true, "a second failure is the failure it is today");
  assert.equal((dead.exit as { _tag: string })._tag, "FabrikaError");
});

test("a posted body still holding a host path is put back", async () => {
  const kept = await exercise(openPullRequest.run, { ...withCapture, captures: [framed], body: "verbatim" });
  assert.deepEqual(kept.recording.edited, [TODAYS_BODY], "the body a reader can follow replaces the one they cannot");

  const rewritten = await exercise(openPullRequest.run, { ...withCapture, captures: [framed] });
  assert.deepEqual(rewritten.recording.edited, [], "a forge that rewrote the paths is left alone");

  const words = await exercise(openPullRequest.run, { ...withCapture, captures: [texted], body: "verbatim" });
  assert.ok(words.recording.prs[0]!.body.includes("## Before / After"));
  assert.deepEqual(words.recording.edited, [], "a text-only section has no host path to look for");
});

test("a resumed run that already opened the pull request asks nothing", async () => {
  const { failed, recording } = await exercise(openPullRequest.run, {
    ...withCapture,
    captures: [framed],
    state: { prNumber: 7, branch: "domen-perko/feat/FAB-1/a-thing" },
  });

  assert.equal(failed, false);
  assert.deepEqual(recording.prs, [], "no second pull request");
  assert.deepEqual(recording.captures, [], "and no second capture, so the run costs nothing it already paid");
});

test("a base sha that is not one is no base at all", async () => {
  // `git rev-parse` warns on stderr and still exits zero when a branch and a
  // tag share a name, and the adapter interleaves stderr into the output. The
  // string becomes a directory the host empties recursively and the `Before
  // (`…`)` header a reviewer reads, so it is checked before it is either.
  const { failed, recording } = await exercise(openPullRequest.run, {
    config: { pr: { draft: true, emptyCommit: false, capture: [console_] } },
    captures: [framed],
    baseSha: "warning: refname 'origin/main' is ambiguous.\na1b2c3d4e5f6",
  });

  assert.equal(failed, false);
  assert.deepEqual(recording.captures, [], "no command ran against a base nobody can name");
  assert.equal(recording.prs[0]!.body, TODAYS_BODY);
  assert.ok(
    recording.log.some((line) => line.includes("captures: no section")),
    "and the operator is told, as every other missing half on this branch is",
  );
});

/** An agent that decides a capture: the structured answer `asCaptureDecision` reads. */
const decides = (answer: Record<string, unknown>) => () => ({ text: "", structured: answer });

const SWITCHED_ON = { config: { pr: { draft: true, emptyCommit: true, beforeAfter: true } } };

test("a pinned capture is the whole decision; the agent is never asked", async () => {
  const { failed, recording } = await exercise(openPullRequest.run, {
    config: { pr: { draft: true, emptyCommit: false, beforeAfter: true, capture: [console_] } },
    captures: [framed],
    agent: decides({ capture: true, name: "other", run: "echo other", reason: "would have" }),
  });

  assert.equal(failed, false);
  assert.deepEqual(recording.agent, [], "a human pinned the command, so nothing is re-decided");
  assert.deepEqual(recording.captures, [{ name: "console", sha: "a1b2c3d4e5f6" }], "and the pinned one is what ran");
});

test("the switch alone asks once, and the answer is what runs", async () => {
  const { failed, recording } = await exercise(openPullRequest.run, {
    ...SWITCHED_ON,
    captures: [framed],
    agent: decides({ capture: true, name: "console", run: "node scripts/capture-console.ts", reason: "the run screen changed" }),
  });

  assert.equal(failed, false);
  assert.equal(recording.agent.length, 1, "exactly one call, however many captures come back");
  assert.equal(recording.agent[0]!.stage, "capture", "its own session, not a resume of the review");
  assert.ok(recording.agent[0]!.jsonSchema, "structured, so the answer is a decision rather than prose");
  assert.deepEqual(recording.captures, [{ name: "console", sha: "a1b2c3d4e5f6" }]);
  assert.ok(recording.prs[0]!.body.includes("## Before / After"));
  assert.ok(recording.log.some((line) => line.includes("the run screen changed")), "the operator is told why");
});

test("no surface changed is an answer, and nothing is run", async () => {
  const { failed, recording } = await exercise(openPullRequest.run, {
    ...SWITCHED_ON,
    captures: [framed],
    agent: decides({ capture: false, reason: "types and tests only" }),
  });

  assert.equal(failed, false);
  assert.equal(recording.agent.length, 1);
  assert.deepEqual(recording.captures, [], "no command ran, in either checkout");
  assert.equal(recording.prs[0]!.body, TODAYS_BODY, "and the body is the one there is today");
  assert.ok(recording.log.some((line) => line.includes("types and tests only")));
});

test("a capture may never fail a run, however the call breaks", async () => {
  for (const agentFails of ["AgentFailed", "AgentRateLimited", "AgentUnauthorized"] as const) {
    const { failed, recording } = await exercise(openPullRequest.run, { ...SWITCHED_ON, agentFails, captures: [framed] });

    assert.equal(failed, false, `${agentFails} still opens the pull request`);
    assert.equal(recording.prs.length, 1);
    assert.equal(recording.prs[0]!.body, TODAYS_BODY);
    assert.deepEqual(recording.captures, []);
    assert.ok(recording.log.some((line) => line.includes(agentFails)), "and the journal names which way it broke");
  }
});

test("an answer the host will not act on is rejected, not run", async () => {
  const refused = [
    { capture: true, name: "console", run: "git push --force origin main", reason: "laundering the deny list" },
    { capture: true, name: "../../etc", run: "echo hi", reason: "a name that is a path" },
    { capture: true, name: "console", run: "   ", reason: "no command at all" },
    { capture: true, reason: "no command at all" },
  ];

  for (const answer of refused) {
    const { failed, recording } = await exercise(openPullRequest.run, {
      ...SWITCHED_ON,
      captures: [framed],
      agent: decides(answer),
    });
    assert.equal(failed, false);
    assert.deepEqual(recording.captures, [], `nothing ran for ${JSON.stringify(answer.name ?? null)}`);
    assert.equal(recording.prs[0]!.body, TODAYS_BODY);
    assert.ok(
      recording.log.some((line) => line.includes("rejected:")),
      "the journal says the host refused the answer, not that the branch changed nothing",
    );
  }
});

test("the switch off is off, whatever the config still lists", async () => {
  const { failed, recording } = await exercise(openPullRequest.run, {
    config: { pr: { draft: true, emptyCommit: true, beforeAfter: false, capture: [console_] } },
    captures: [framed],
    agent: decides({ capture: true, name: "console", run: "echo hi", reason: "would have" }),
  });

  assert.equal(failed, false);
  assert.deepEqual(recording.agent, [], "nothing is asked");
  assert.deepEqual(recording.captures, [], "and nothing is run");
  assert.equal(recording.prs[0]!.body, TODAYS_BODY);
});
