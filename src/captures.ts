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
  /** Whether the base half came from the cache; for the journal only. */
  readonly cached: boolean;
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

const short = (sha: string) => sha.slice(0, 7);

const names = (shot: Shot) => [...new Set([...(shot.before ?? []), ...(shot.after ?? [])].map((file) => file.name))];

const find = (files: ReadonlyArray<CaptureFile> | undefined, name: string) => files?.find((file) => file.name === name);

/**
 * The Before / After section, or `undefined` when nothing survives.
 *
 * Pure over the shots it is handed: every shape the body can take is
 * reachable from a plain call, which is why the rendering lives here rather
 * than in the step or the adapter.
 */
export const beforeAfter = (shots: ReadonlyArray<Shot>, options: BeforeAfterOptions): Section | undefined => {
  const attachments: Array<string> = [];
  const blocks: Array<string> = [];

  for (const shot of shots) {
    // A before-only comparison is not evidence, so half a shot is no shot.
    if (!shot.after) continue;
    const rows: Array<string> = [];
    for (const name of names(shot)) {
      const before = find(shot.before, name);
      const after = find(shot.after, name);
      if (after?.kind !== "image" || before?.kind !== "image") continue;
      attachments.push(before.content, after.content);
      rows.push(`| \`${name}\` | ![before](${before.content}) | ![after](${after.content}) |`);
    }
    if (rows.length === 0) continue;
    blocks.push(
      [
        `| ${shot.capture} | Before (\`${short(options.baseSha)}\`) | After (\`${short(options.headSha)}\`) |`,
        "| --- | --- | --- |",
        ...rows,
      ].join("\n"),
    );
  }

  if (blocks.length === 0) return undefined;
  return {
    markdown: [
      "## Before / After",
      "",
      "Captured by the host from `pr.capture`, at the base and on this branch.",
      "",
      ...blocks,
    ].join("\n"),
    attachments,
  };
};
