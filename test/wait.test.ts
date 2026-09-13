import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { Journal, waitFor } from "../src/ports/journal.ts";
import type { RunEvent } from "../src/run-event.ts";
import { harness } from "./harness.ts";

/** The wait events a run recorded, in order — the only thing this seam is about. */
const waits = (events: ReadonlyArray<RunEvent | string>) =>
  events.filter((entry): entry is Extract<RunEvent, { kind: "wait" }> => typeof entry !== "string" && entry.kind === "wait");

/** The harness's in-memory `Journal`, which is the agreed stand-in for the real one. */
const journalOf = (world: ReturnType<typeof harness>) =>
  Effect.runSync(Effect.gen(function* () {
    return yield* Journal;
  }).pipe(Effect.provide(world.layer)));

test("a wait opens with its subject and deadline and closes with how long it took", async () => {
  const world = harness();
  const journal = journalOf(world);
  const answer = await Effect.runPromise(Effect.succeed(7).pipe(waitFor(journal, "checks on abc1234", 20)));

  assert.equal(answer, 7, "the effect's own value passes through untouched");
  assert.deepEqual(
    waits(world.recording.events).map((event) => [event.state, event.subject, event.deadlineMinutes]),
    [
      ["start", "checks on abc1234", 20],
      ["end", "checks on abc1234", undefined],
    ],
  );
  // The deadline rides on the event for the live region to count against; the
  // plain line stays byte-identical to the one the poll loop wrote per poll.
  assert.deepEqual(world.recording.log, ["waiting for checks on abc1234", "waited 0s for checks on abc1234"]);
});

test("a wait closes even when what it was waiting on fails", async () => {
  const world = harness();
  const journal = journalOf(world);
  const failed = await Effect.runPromise(
    Effect.fail("the reviewer never answered").pipe(waitFor(journal, "fake review of abc1234"), Effect.flip),
  );

  assert.equal(failed, "the reviewer never answered");
  assert.deepEqual(waits(world.recording.events).map((event) => event.state), ["start", "end"], "an open wait would animate forever");
});

test("each run of the same effect is timed on its own, not from where it was built", async () => {
  const world = harness();
  const journal = journalOf(world);
  const once = Effect.sleep("30 millis").pipe(waitFor(journal, "implement agent"));
  await Effect.runPromise(Effect.sleep("50 millis").pipe(Effect.andThen(once)));
  await Effect.runPromise(once);

  const [, first, , second] = waits(world.recording.events);
  assert.ok(
    (second?.seconds ?? 0) <= (first?.seconds ?? 0) + 0.02,
    `the second run timed itself, not the gap since construction (${first?.seconds} then ${second?.seconds})`,
  );
});
