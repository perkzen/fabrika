import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openConsole } from "../src/infra/console.ts";
import type { RunEvent } from "../src/run-event.ts";

/**
 * This repo's own capture: what a run looks like on a terminal.
 *
 * It replays a fixture through the presenter and never runs a ticket — a
 * capture that costs an agent bill twice per pull request is a capture nobody
 * turns on.
 */
const FIXTURE: ReadonlyArray<RunEvent | string> = [
  { kind: "run", completed: ["spec", "plan"], steps: [
    { name: "spec", done: true },
    { name: "plan", done: true },
    { name: "implement", done: false },
    { name: "review", done: false },
  ] },
  { kind: "step", name: "implement", at: 3, of: 4, state: "start" },
  { kind: "agent", stage: "implement", markdown: "Working the plan's **third slice**: the read-back that puts the plain body\nback when a host path survived the upload.\n\n- `test/pull-request.test.ts` — the failing test\n- `src/pipeline/steps/pull-request.ts` — the step" },
  { kind: "tool", stage: "implement", tool: "Read", subject: "src/pipeline/steps/pull-request.ts" },
  { kind: "tool", stage: "implement", tool: "Edit", subject: "src/captures.ts" },
  { kind: "cost", stage: "implement", usd: 0.41 },
  { kind: "gate", name: "compile", at: 1, of: 3, command: "pnpm compile", state: "pass", seconds: 3 },
  { kind: "gate", name: "build", at: 2, of: 3, command: "pnpm build", state: "pass", seconds: 5 },
  { kind: "gate", name: "test", at: 3, of: 3, command: "pnpm test", state: "start" },
  { kind: "wait", state: "start", subject: "the gate", deadlineMinutes: 30 },
];

const COLUMNS = 96;

/** A stream the presenter will dress: a capture's stdout is not a TTY, and the plain form is the half with no difference to show. */
const sink = () => {
  const chunks: Array<string> = [];
  const stream = { write: (chunk: string) => void chunks.push(chunk), on: () => stream, isTTY: true, columns: COLUMNS };
  return { stream: stream as unknown as NodeJS.WriteStream, text: () => chunks.join("") };
};

/**
 * Enough of a terminal to read the presenter's own output back: it moves the
 * cursor up and erases to the end of the screen to redraw its live region, so
 * stripping the escapes alone would leave every erased frame in the text.
 */
const replay = (ansi: string): string => {
  const lines: Array<string> = [""];
  let row = 0;
  let col = 0;
  const put = (text: string) => {
    const line = lines[row] ?? "";
    lines[row] = line.padEnd(col, " ").slice(0, col) + text + line.slice(col + text.length);
    col += text.length;
  };

  for (const [, escape, text] of ansi.matchAll(/(?:(\x1b\[[0-9;?]*[A-Za-z])|([^\x1b]+))/g)) {
    if (text) {
      for (const [index, part] of text.split("\n").entries()) {
        if (index > 0) {
          row += 1;
          col = 0;
          while (lines.length <= row) lines.push("");
        }
        if (part) put(part.replace(/\r/g, ""));
      }
      continue;
    }
    const code = escape!;
    const up = /^\x1b\[(\d*)A$/.exec(code);
    if (up) row = Math.max(0, row - (Number(up[1] || "1") || 1));
    else if (/^\x1b\[0?J$/.test(code)) lines.length = row + 1;
  }
  return lines.join("\n").replace(/[ \t]+$/gm, "").replace(/\n+$/, "") + "\n";
};

const dir = process.env.FABRIKA_CAPTURE_DIR;
if (!dir) {
  console.error("FABRIKA_CAPTURE_DIR is not set; this script is run by fabrika, from `pr.capture`.");
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

const surface = sink();
// A fixed clock: the stamp is on every line, and a capture whose two halves
// differ only by the time they ran shows a diff that is all noise.
let tick = new Date(2026, 0, 1, 12, 0, 0).getTime();
const presenter = openConsole({ stream: surface.stream, interactive: true, now: () => (tick += 1000) });
for (const event of FIXTURE) presenter.show(event);
// Snapshotted before `end()`, because `end()` erases the live region and the
// live region is the thing worth showing.
const ansi = surface.text();
presenter.end();

// Whichever `freeze`-class tool is on PATH; no screenshot library enters this
// repo's dependencies, so the host machine is the toolchain.
const ansiFile = join(dir, "console.ansi");
writeFileSync(ansiFile, ansi);
const png = join(dir, "console.png");
const frozen = spawnSync("freeze", [ansiFile, "--output", png, "--language", "ansi", "--width", String(COLUMNS * 9)], {
  stdio: "ignore",
});

if (frozen.status === 0) {
  console.log(`wrote ${png}`);
} else {
  const txt = join(dir, "console.txt");
  writeFileSync(txt, replay(ansi));
  console.log(`no freeze on PATH; wrote ${txt}`);
}
