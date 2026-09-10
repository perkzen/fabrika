import { Data, Effect, FileSystem, Path } from "effect";

/**
 * The one record every stage consumes. It can come from a Linear issue or a
 * local spec file; nothing downstream can tell which.
 */
export type TicketType = "feat" | "fix" | "chore";

export type Ticket = {
  readonly identifier: string;
  readonly title: string;
  readonly description: string;
  readonly url?: string;
  readonly type: TicketType;
};

export class TicketNotFound extends Data.TaggedError("TicketNotFound")<{ readonly identifier: string }> {}
export class TicketSourceError extends Data.TaggedError("TicketSourceError")<{ readonly message: string }> {}

const asType = (raw: string | undefined): TicketType =>
  raw === "fix" || raw === "chore" ? raw : "feat";

/** start-linear-ticket's mapping: feature/story → feat, bug → fix, chore/task → chore. */
const typeFromLabels = (labels: ReadonlyArray<string>): TicketType => {
  const lower = labels.map((l) => l.toLowerCase());
  if (lower.some((l) => /bug|fix/.test(l))) return "fix";
  if (lower.some((l) => /chore|task|maintenance/.test(l))) return "chore";
  return "feat";
};

/**
 * Optional `key: value` frontmatter between `---` lines, then markdown whose
 * first `# H1` is the title. Deliberately not YAML: three scalar keys do not
 * earn a parser.
 */
export const fromFile = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError(() => new TicketSourceError({ message: `cannot read spec file ${file}` })));

    const front: Record<string, string> = {};
    let body = raw;
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    if (m) {
      body = raw.slice(m[0].length);
      for (const line of m[1]!.split(/\r?\n/)) {
        const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*(?:#.*)?$/.exec(line);
        if (kv) front[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "");
      }
    }

    const h1 = /^#\s+(.+?)\s*$/m.exec(body);
    const title = front.title ?? h1?.[1];
    if (!title) return yield* new TicketSourceError({ message: `${file}: no title: frontmatter or a "# heading"` });
    const description = (h1 && !front.title ? body.replace(h1[0], "") : body).trim();

    const stem = path.basename(file).replace(/\.[^.]+$/, "");
    const linear = front.linear?.trim();
    const identifier = linear || front.id || stem;
    return {
      identifier,
      title,
      description,
      ...(linear ? { url: `https://linear.app/issue/${linear}` } : {}),
      type: asType(front.type),
    } satisfies Ticket;
  });

/**
 * One GraphQL POST. Personal API keys go in `Authorization` bare (Linear's
 * docs); this is the same read-only key the `linear-ro` MCP entry uses.
 */
export const fromLinear = (identifier: string, apiKey: string) =>
  Effect.gen(function* () {
    const query = `query($id: String!) { issue(id: $id) { identifier title description url labels { nodes { name } } } }`;
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: apiKey },
          body: JSON.stringify({ query, variables: { id: identifier } }),
        }).then(async (r) => ({ status: r.status, json: (await r.json()) as LinearResponse })),
      catch: (e) => new TicketSourceError({ message: `linear: ${String(e)}` }),
    });
    if (res.status === 401 || res.status === 403) {
      return yield* new TicketSourceError({ message: `linear: HTTP ${res.status} — check LINEAR_API_KEY` });
    }
    const issue = res.json.data?.issue;
    if (!issue) {
      const why = res.json.errors?.map((e) => e.message).join("; ");
      return why && !/not found|entity/i.test(why)
        ? yield* new TicketSourceError({ message: `linear: ${why}` })
        : yield* new TicketNotFound({ identifier });
    }
    return {
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      url: issue.url,
      type: typeFromLabels(issue.labels?.nodes.map((n) => n.name) ?? []),
    } satisfies Ticket;
  });

type LinearResponse = {
  data?: {
    issue?: {
      identifier: string;
      title: string;
      description?: string | null;
      url: string;
      labels?: { nodes: Array<{ name: string }> };
    } | null;
  };
  errors?: Array<{ message: string }>;
};

const FILLER = new Set(["a", "an", "the", "for", "to", "new", "of", "and", "in", "on", "with", "implement", "add"]);

/** Kebab-case, 2–4 words, ~30 chars, filler dropped — per start-linear-ticket. */
export const slug = (title: string): string => {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
  const kept = words.filter((w) => !FILLER.has(w));
  const pool = kept.length >= 2 ? kept : words;
  const out: Array<string> = [];
  for (const w of pool) {
    if (out.length >= 4) break;
    if (out.length >= 2 && [...out, w].join("-").length > 30) break;
    out.push(w);
  }
  return out.join("-") || "ticket";
};

/** What the `fabrika:branch-naming` call returns; the host fills the pattern. */
export type BranchParts = { readonly type: TicketType; readonly slug: string; readonly preview: boolean };

export const BRANCH_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    type: { type: "string", enum: ["feat", "fix", "chore"] },
    slug: { type: "string" },
    preview: { type: "boolean" },
  },
  required: ["type", "slug", "preview"],
});

/** Accepts the model's answer only when it obeys the naming rules; otherwise the caller falls back to the deterministic parts. */
export const asBranchParts = (raw: unknown): BranchParts | null => {
  const r = raw as Partial<BranchParts> | undefined;
  if (!r || (r.type !== "feat" && r.type !== "fix" && r.type !== "chore")) return null;
  if (typeof r.slug !== "string" || !/^[a-z0-9]+(-[a-z0-9]+){0,5}$/.test(r.slug) || r.slug.length > 40) return null;
  if (typeof r.preview !== "boolean") return null;
  return { type: r.type, slug: r.slug, preview: r.preview };
};

/** The deterministic parts: the ticket's own type, a slug cut from the title, preview on. */
export const defaultParts = (ticket: Ticket): BranchParts => ({ type: ticket.type, slug: slug(ticket.title), preview: true });

export const branchName = (pattern: string, ticket: Ticket, parts: BranchParts = defaultParts(ticket), previewPrefix = ""): string =>
  ((parts.preview ? previewPrefix : "") + pattern)
    .replace("{type}", parts.type)
    .replace("{ticket}", ticket.identifier)
    .replace("{slug}", parts.slug)
    .replace(/[^A-Za-z0-9/._-]+/g, "-");
