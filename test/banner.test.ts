import assert from "node:assert/strict";
import { test } from "node:test";
import { banner } from "../src/infra/banner.ts";

/** A stream the banner can own: it writes and it has a width. */
const sink = (columns?: number) => {
  const chunks: Array<string> = [];
  return {
    stream: { write: (chunk: string) => void chunks.push(chunk), columns } as unknown as NodeJS.WriteStream,
    text: () => chunks.join(""),
  };
};

/** What the operator actually sees: the escape codes stripped back out. */
const visible = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

test("a plain sink gets no banner at all, so a piped run stays a log", () => {
  const out = sink(120);
  banner({ stream: out.stream, version: "1.2.3", interactive: false });
  assert.equal(out.text(), "");
});

test("a wide terminal gets the block, the author and the version", () => {
  const out = sink(120);
  banner({ stream: out.stream, version: "1.2.3", interactive: true });
  const seen = visible(out.text());
  assert.match(seen, /█/);
  assert.match(seen, /by perkzen · v1\.2\.3/);
});

test("a terminal too narrow for the block gets the one-line form instead", () => {
  const out = sink(40);
  banner({ stream: out.stream, version: "1.2.3", interactive: true });
  const seen = visible(out.text());
  assert.doesNotMatch(seen, /█/);
  assert.match(seen, /fabrika — by perkzen · v1\.2\.3/);
});

test("no line the banner writes can wrap the terminal it is drawn on", () => {
  for (const columns of [20, 52, 80]) {
    const out = sink(columns);
    banner({ stream: out.stream, version: "1.2.3", interactive: true });
    for (const line of visible(out.text()).split("\n")) {
      assert.ok(line.length <= columns - 1, `${line.length} > ${columns - 1} at ${columns} columns`);
    }
  }
});
