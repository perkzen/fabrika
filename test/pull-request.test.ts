import assert from "node:assert/strict";
import { test } from "node:test";
import type { Shot } from "../src/captures.ts";
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
  cached: false,
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
