import { Data } from "effect";

/**
 * The one record every stage consumes, read off the markdown file the run was
 * given. Its `url` is the ticket's `linear:` frontmatter resolved to a link —
 * the issue itself is the agent's to read, through the `linear-ro` MCP server
 * a stage declares.
 */
export type TicketType = "feat" | "fix" | "chore";

export type Ticket = {
  readonly identifier: string;
  readonly title: string;
  readonly description: string;
  readonly url?: string;
  readonly type: TicketType;
};

export class TicketSourceError extends Data.TaggedError("TicketSourceError")<{ readonly message: string }> {}

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

export const branchName = (
  pattern: string,
  ticket: Ticket,
  parts: BranchParts = defaultParts(ticket),
  previewPrefix = "",
  user = "",
): string =>
  ((parts.preview ? previewPrefix : "") + pattern)
    .replace("{user}", user)
    .replace("{type}", parts.type)
    .replace("{ticket}", ticket.identifier)
    .replace("{slug}", parts.slug)
    .replace(/[^A-Za-z0-9/._-]+/g, "-");
