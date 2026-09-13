import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beforeAfter,
  kindOf,
  linkTarget,
  textContent,
  SECTION_CHARS,
  type BeforeAfterOptions,
  type CaptureFile,
  type Shot,
} from "../src/captures.ts";

const OPTIONS: BeforeAfterOptions = { baseSha: "a1b2c3d4e5", headSha: "e4f5g6h7i8", images: true };

const image = (name: string, content: string): CaptureFile => ({ name, kind: "image", content });
const text = (name: string, content: string): CaptureFile => ({ name, kind: "text", content });
const link = (name: string, content: string): CaptureFile => ({ name, kind: "link", content });

const shot = (capture: string, before: Shot["before"], after: Shot["after"]): Shot => ({ capture, before, after });

const HEAD = "## Before / After\n\nCaptured by the host from `pr.capture`, at the base and on this branch.\n\n";

/** Each case is written out by hand: the expected markdown is the source of truth, not the implementation. */
const cases: ReadonlyArray<{
  readonly name: string;
  readonly shots: ReadonlyArray<Shot>;
  readonly options?: Partial<BeforeAfterOptions>;
  readonly markdown: string | undefined;
  readonly attachments?: ReadonlyArray<string>;
}> = [
  {
    name: "files pair by name",
    shots: [shot("console", [image("frame.png", "/b/frame.png")], [image("frame.png", "/a/frame.png")])],
    markdown:
      HEAD +
      "| console | Before (`a1b2c3d`) | After (`e4f5g6h`) |\n" +
      "| --- | --- | --- |\n" +
      "| `frame.png` | ![before](/b/frame.png) | ![after](/a/frame.png) |",
    attachments: ["/b/frame.png", "/a/frame.png"],
  },
  {
    name: "a name on one side only says which side it is missing from",
    shots: [shot("console", [image("old.png", "/b/old.png")], [image("new.png", "/a/new.png")])],
    markdown:
      HEAD +
      "| console | Before (`a1b2c3d`) | After (`e4f5g6h`) |\n" +
      "| --- | --- | --- |\n" +
      "| `old.png` | ![before](/b/old.png) | _(gone from this branch)_ |\n" +
      "| `new.png` | _(new on this branch)_ | ![after](/a/new.png) |",
    attachments: ["/b/old.png", "/a/new.png"],
  },
  {
    name: "a text block and a link line follow the table",
    shots: [
      shot(
        "console",
        [image("frame.png", "/b/frame.png"), text("out.txt", "old"), link("preview.url", "https://before.example")],
        [image("frame.png", "/a/frame.png"), text("out.txt", "new"), link("preview.url", "https://after.example")],
      ),
    ],
    markdown:
      HEAD +
      "| console | Before (`a1b2c3d`) | After (`e4f5g6h`) |\n" +
      "| --- | --- | --- |\n" +
      "| `frame.png` | ![before](/b/frame.png) | ![after](/a/frame.png) |\n" +
      "\n" +
      "**console — `out.txt`**\n" +
      "\n" +
      "Before:\n" +
      "\n" +
      "```\nold\n```\n" +
      "\n" +
      "After:\n" +
      "\n" +
      "```\nnew\n```\n" +
      "\n" +
      "**console — `preview.url`**: [before](https://before.example) · [after](https://after.example)",
    attachments: ["/b/frame.png", "/a/frame.png"],
  },
  {
    name: "a text file the capture only wrote on the branch says so instead of a block",
    shots: [shot("console", [], [text("out.txt", "new")])],
    markdown:
      HEAD +
      "**console — `out.txt`**\n" +
      "\n" +
      "Before: _(new on this branch)_\n" +
      "\n" +
      "After:\n" +
      "\n" +
      "```\nnew\n```",
    attachments: [],
  },
  {
    name: "a fence longer than any run of backticks in the text, so captured bytes cannot break out of it",
    shots: [shot("console", undefined, [text("out.txt", "see ``` here")])],
    markdown:
      HEAD +
      "**console — `out.txt`**\n" +
      "\n" +
      "Before: _(new on this branch)_\n" +
      "\n" +
      "After:\n" +
      "\n" +
      "````\nsee ``` here\n````",
    attachments: [],
  },
  {
    name: "an old gh drops the images and a shot with nothing left goes with them",
    shots: [
      shot("console", [image("frame.png", "/b/frame.png")], [image("frame.png", "/a/frame.png")]),
      shot("cli", [text("out.txt", "old")], [text("out.txt", "new")]),
    ],
    options: { images: false },
    markdown:
      HEAD +
      "**cli — `out.txt`**\n" +
      "\n" +
      "Before:\n" +
      "\n" +
      "```\nold\n```\n" +
      "\n" +
      "After:\n" +
      "\n" +
      "```\nnew\n```",
    attachments: [],
  },
  {
    name: "a capture whose after half is absent is dropped entirely",
    shots: [shot("console", [image("frame.png", "/b/frame.png")], undefined)],
    markdown: undefined,
  },
  {
    name: "no shots at all means no section",
    shots: [],
    markdown: undefined,
  },
  {
    name: "a shot whose after half wrote nothing usable means no section",
    shots: [shot("console", [image("frame.png", "/b/frame.png")], [])],
    markdown: undefined,
  },
];

for (const one of cases) {
  test(`the section renders each shape it has: ${one.name}`, () => {
    const section = beforeAfter(one.shots, { ...OPTIONS, ...one.options });
    assert.equal(section?.markdown, one.markdown);
    if (one.attachments) assert.deepEqual(section?.attachments, one.attachments);
  });
}

test("the section is capped, and captures are dropped from the end until it fits", () => {
  const filler = Array.from({ length: 20 }, () => "x".repeat(200)).join("\n");
  const shots = Array.from({ length: 8 }, (_, n) => shot(`c${n}`, [text("out.txt", filler)], [text("out.txt", filler)]));

  const section = beforeAfter(shots, OPTIONS)!;
  assert.ok(section.markdown.length <= SECTION_CHARS, `section is ${section.markdown.length} characters`);
  assert.ok(section.markdown.includes("**c0 — `out.txt`**"), "the first capture survives");
  assert.ok(!section.markdown.includes("**c7 — `out.txt`**"), "the last one is dropped");
});

test("a capture's text is scrubbed, capped at 20 lines and truncated at 200 characters", () => {
  const capped = textContent(Array.from({ length: 25 }, (_, n) => `line ${n}`).join("\n"));
  assert.equal(capped.split("\n").length, 21);
  assert.equal(capped.split("\n").at(-1), "… 5 more lines");
  assert.equal(capped.split("\n")[0], "line 0");

  assert.equal(textContent("x".repeat(250)), "x".repeat(200));
  assert.equal(textContent("be[31mll"), "be[31mll", "control characters are not carried into a body");
});

test("a link must be https and is capped, and anything else is not a link at all", () => {
  assert.equal(linkTarget("https://example.com/a\nhttps://example.com/b"), "https://example.com/a");
  assert.equal(linkTarget("http://example.com"), undefined);
  assert.equal(linkTarget("javascript:alert(1)"), undefined);
  assert.equal(linkTarget("file:///etc/passwd"), undefined);
  assert.equal(linkTarget(""), undefined);
  assert.equal(linkTarget(`https://example.com/${"a".repeat(600)}`)?.length, 500);
});

test("a file's kind is its extension, and an unknown one is not a file the body carries", () => {
  assert.equal(kindOf("frame.PNG"), "image");
  for (const name of ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp"]) assert.equal(kindOf(name), "image", name);
  assert.equal(kindOf("out.txt"), "text");
  assert.equal(kindOf("preview.url"), "link");
  assert.equal(kindOf("notes.md"), undefined);
  assert.equal(kindOf("frame"), undefined);
});

test("a name the body cannot quote is not a file the body carries", () => {
  // Every one of these breaks out of the construct the name is rendered
  // inside: the `\`${name}\`` cell, the `| … |` row, or the `![before](path)`
  // destination the same name is the tail of.
  for (const name of ["pipe|d.png", "back`tick.png", "paren).png", "my frame.png", "new\nline.png"]) {
    assert.equal(kindOf(name), undefined, name);
  }
  assert.equal(kindOf("frame-2_a.png"), "image", "the names a capture actually writes still pass");
});
