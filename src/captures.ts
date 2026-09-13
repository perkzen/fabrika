import { scrub } from "./run-event.ts";

/** One file a capture wrote, and how the body may carry it. */
export type CaptureFile = {
  /** The file's name inside `FABRIKA_CAPTURE_DIR`; what the two halves pair on. */
  readonly name: string;
  readonly kind: "image" | "text" | "link";
  /**
   * An image's absolute path on the host — the body references it and the
   * forge uploads it; a link's `https://` target; a text file's scrubbed
   * contents.
   */
  readonly content: string;
};

/** One capture's two halves. Either may be absent: a capture can be new on the branch, or produce nothing. */
export type Shot = {
  readonly capture: string;
  readonly before: ReadonlyArray<CaptureFile> | undefined;
  readonly after: ReadonlyArray<CaptureFile> | undefined;
};

export type BeforeAfterOptions = {
  readonly baseSha: string;
  readonly headSha: string;
  /** False for a `gh` that cannot upload; image files are dropped before anything else. */
  readonly images: boolean;
};

export type Section = {
  readonly markdown: string;
  /** Absolute paths the markdown references; the forge uploads exactly these. */
  readonly attachments: ReadonlyArray<string>;
};

/** A captured text file's height, as the console caps agent speech. */
const MESSAGE_LINES = 20;
const LINE_CHARS = 200;
const URL_CHARS = 500;
/** An order of magnitude inside GitHub's 65536-character body limit. */
export const SECTION_CHARS = 20000;

const IMAGES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/**
 * What a name may be made of. The name is rendered inside three constructs it
 * could otherwise close — a `` `code` `` span, a `| cell |`, and the
 * `![before](…/name)` destination it is the tail of — and nothing upstream
 * sanitises it: a capture writes whatever file names it likes.
 */
const NAME = /^[\w.\-]+$/;

/** A capture's file kind, by name and extension; `undefined` for a file the body cannot carry. */
export const kindOf = (name: string): CaptureFile["kind"] | undefined => {
  if (!NAME.test(name)) return undefined;
  const at = name.lastIndexOf(".");
  if (at <= 0) return undefined;
  const extension = name.slice(at).toLowerCase();
  if (IMAGES.has(extension)) return "image";
  if (extension === ".txt") return "text";
  if (extension === ".url") return "link";
  return undefined;
};

/** Captured bytes are no more trusted than an agent's: scrubbed, then capped in both directions. */
export const textContent = (raw: string): string => {
  const lines = scrub(raw).split("\n").map((line) => line.slice(0, LINE_CHARS));
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const missing = lines.length - MESSAGE_LINES;
  return missing > 0
    ? [...lines.slice(0, MESSAGE_LINES), `… ${missing} more lines`].join("\n")
    : lines.join("\n");
};

/**
 * A `.url`'s target, or `undefined`: a `javascript:` or `file://` target in a
 * body a human clicks is the injection this exists for. Parentheses are out
 * for the same reason — `https://x/)[**Approved**](https://evil/` would close
 * the link the target sits inside and open a second one.
 */
export const linkTarget = (raw: string): string | undefined => {
  const first = scrub(raw).split("\n")[0]?.trim() ?? "";
  return /^https:\/\/[^\s()]+$/.test(first) ? first.slice(0, URL_CHARS) : undefined;
};

const NEW = "_(new on this branch)_";
const GONE = "_(gone from this branch)_";

const short = (sha: string) => sha.slice(0, 7);

/** Longer than any run of backticks in the text, so a capture cannot break out of its own block. */
const fence = (content: string) => {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
};

const block = (content: string) => {
  const wrap = fence(content);
  return `${wrap}\n${content}\n${wrap}`;
};

const pairs = (shot: Shot, kind: CaptureFile["kind"]) => {
  const of = (files: ReadonlyArray<CaptureFile> | undefined) => (files ?? []).filter((file) => file.kind === kind);
  const before = of(shot.before);
  const after = of(shot.after);
  const names = [...new Set([...before, ...after].map((file) => file.name))];
  return names.map((name) => ({
    name,
    before: before.find((file) => file.name === name),
    after: after.find((file) => file.name === name),
  }));
};

const textBlock = (capture: string, pair: ReturnType<typeof pairs>[number]) =>
  [
    `**${capture} — \`${pair.name}\`**`,
    "",
    pair.before ? `Before:\n\n${block(pair.before.content)}` : `Before: ${NEW}`,
    "",
    pair.after ? `After:\n\n${block(pair.after.content)}` : `After: ${GONE}`,
  ].join("\n");

const linkLine = (capture: string, pair: ReturnType<typeof pairs>[number]) => {
  const cell = (file: CaptureFile | undefined, label: string, missing: string) =>
    file ? `[${label}](${file.content})` : missing;
  return `**${capture} — \`${pair.name}\`**: ${cell(pair.before, "before", NEW)} · ${cell(pair.after, "after", GONE)}`;
};

/** One capture's markdown and the paths it references, or `undefined` when it has nothing to show. */
const chunkOf = (shot: Shot, options: BeforeAfterOptions): Section | undefined => {
  const attachments: Array<string> = [];
  const parts: Array<string> = [];

  const rows = options.images
    ? pairs(shot, "image").map((pair) => {
        for (const file of [pair.before, pair.after]) if (file) attachments.push(file.content);
        const cell = (file: CaptureFile | undefined, label: string, missing: string) =>
          file ? `![${label}](${file.content})` : missing;
        return `| \`${pair.name}\` | ${cell(pair.before, "before", NEW)} | ${cell(pair.after, "after", GONE)} |`;
      })
    : [];

  if (rows.length > 0) {
    parts.push(
      [
        `| ${shot.capture} | Before (\`${short(options.baseSha)}\`) | After (\`${short(options.headSha)}\`) |`,
        "| --- | --- | --- |",
        ...rows,
      ].join("\n"),
    );
  }
  for (const pair of pairs(shot, "text")) parts.push(textBlock(shot.capture, pair));
  for (const pair of pairs(shot, "link")) parts.push(linkLine(shot.capture, pair));

  return parts.length === 0 ? undefined : { markdown: parts.join("\n\n"), attachments };
};

/**
 * The Before / After section, or `undefined` when nothing survives.
 *
 * Pure over the shots it is handed: every shape the body can take is
 * reachable from a plain call, which is why the rendering lives here rather
 * than in the step or the adapter.
 */
export const beforeAfter = (shots: ReadonlyArray<Shot>, options: BeforeAfterOptions): Section | undefined => {
  const head = "## Before / After\n\nCaptured by the host from `pr.capture`, at the base and on this branch.\n\n";

  const attachments: Array<string> = [];
  const chunks: Array<string> = [];
  let length = head.length;

  for (const shot of shots) {
    // A before-only comparison is not evidence, so half a shot is no shot —
    // and a half that ran but wrote nothing is the same half.
    if (!shot.after || shot.after.length === 0) continue;
    const chunk = chunkOf(shot, options);
    if (!chunk) continue;
    // Dropped from the end rather than truncated: a half-written table is
    // worse to read than a missing capture.
    const cost = chunk.markdown.length + (chunks.length === 0 ? 0 : 2);
    if (length + cost > SECTION_CHARS) break;
    length += cost;
    chunks.push(chunk.markdown);
    attachments.push(...chunk.attachments);
  }

  return chunks.length === 0 ? undefined : { markdown: head + chunks.join("\n\n"), attachments };
};
