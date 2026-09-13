import assert from "node:assert/strict";
import { test } from "node:test";
import { openConsole } from "../src/infra/console.ts";

/** Local noon on a fixed day: the stamp is `toLocaleTimeString`, so the clock must be local, not UTC. */
const noon = () => new Date(2026, 0, 1, 12, 0, 0).getTime();

/** A stream the presenter can own: it writes, it has a width, and it takes an error listener. */
const sink = (options: { isTTY?: boolean; columns?: number } = {}) => {
  const chunks: Array<string> = [];
  const stream = {
    write: (chunk: string) => void chunks.push(chunk),
    on: () => stream,
    isTTY: options.isTTY ?? false,
    columns: options.columns,
  };
  return { stream: stream as unknown as NodeJS.WriteStream, chunks, text: () => chunks.join("") };
};

test("a step event reaches a plain sink as the line it replaces, stamped and nothing else", () => {
  const out = sink();
  const presenter = openConsole({ stream: out.stream, interactive: false, now: noon });
  presenter.show({ kind: "step", name: "refactor", at: 1, of: 1, state: "skipped", reason: "fix ticket" });
  presenter.end();
  assert.equal(out.text(), "12:00:00 refactor: skipped (fix ticket)\n");
});
