import { marked, type Token, type Tokens } from "marked";
import type { Styler } from "./surface.ts";

const INDENT = "  ";

/** `marked` types a nested token as the open `Generic` shape, so narrowing to a list is explicit. */
const isList = (token: Token): token is Tokens.List => token.type === "list" && "items" in token;

/** `marked`'s lexer only: it finds the structure, and the rendered shape stays ours because the height cap is ours. */
export const renderMarkdown = (markdown: string, style: Styler): ReadonlyArray<string> =>
  marked.lexer(markdown).flatMap((token) => block(token, style, ""));

const inline = (tokens: ReadonlyArray<Token> | undefined, style: Styler, fallback: string): string => {
  if (!tokens || tokens.length === 0) return fallback;
  return tokens
    .map((token) => {
      switch (token.type) {
        case "strong":
          return style("bold", inline(token.tokens, style, token.text));
        case "em":
          return style("italic", inline(token.tokens, style, token.text));
        case "codespan":
          return style("cyan", token.text);
        case "br":
          return "\n";
        case "text":
          return "tokens" in token && token.tokens ? inline(token.tokens, style, token.text) : token.text;
        default:
          // Its own text, never its markdown: a link arrives as its label
          // and loses its href. That is the rule FAB-1 settled on —
          // everything unhandled falls through as its text — and the
          // archive is where the raw form survives.
          return "text" in token && typeof token.text === "string" ? token.text : (token.raw ?? "");
      }
    })
    .join("");
};

const block = (token: Token, style: Styler, indent: string): ReadonlyArray<string> => {
  switch (token.type) {
    case "space":
      return [""];
    case "heading":
      return [style("bold", `${indent}${"#".repeat(token.depth)} ${inline(token.tokens, style, token.text)}`)];
    case "paragraph":
      return inline(token.tokens, style, token.text)
        .split("\n")
        .map((line) => indent + line);
    case "list":
      return isList(token) ? list(token, style, indent) : [];
    case "code":
      return [
        ...(token.lang ? [style("dim", `${indent}${INDENT}${token.lang}`)] : []),
        // Highlighting is deliberately not attempted; the indent and the dim
        // are what separate the block from the prose around it.
        ...String(token.text).split("\n").map((line) => style("dim", `${indent}${INDENT}${line}`)),
      ];
    case "blockquote":
      return (token.tokens ?? [])
        .flatMap((inner) => block(inner, style, ""))
        .map((line) => `${indent}│ ${line}`);
    case "hr":
      return [style("dim", `${indent}───`)];
    default:
      return ("raw" in token ? String(token.raw) : "").trimEnd().split("\n").map((line) => indent + line);
  }
};

const list = (token: Tokens.List, style: Styler, indent: string): ReadonlyArray<string> => {
  const start = Number(token.start) || 1;
  return token.items.flatMap((item, index) => {
    // A tick box belongs to the marker, not to a line of its own: `marked`
    // makes it a sibling of the text it ticks, so walking it as a block puts
    // `[ ]` above the item and costs a checklist twice its height.
    const box = item.task ? `[${item.checked ? "x" : " "}] ` : "";
    const marker = `${token.ordered ? `${start + index}.` : "•"} ${box}`;
    const lines: Array<string> = [];
    for (const inner of item.tokens) {
      if (inner.type === "checkbox") continue;
      // A nested list is the one child that indents; everything else is the
      // item's own prose and sits behind the marker.
      if (isList(inner)) lines.push(...list(inner, style, indent + INDENT));
      else if (inner.type === "text") lines.push(...inline(inner.tokens, style, inner.text).split("\n"));
      else lines.push(...block(inner, style, ""));
    }
    const [first = "", ...rest] = lines;
    return [`${indent}${marker}${first}`, ...rest.map((line) => (line.startsWith(INDENT) ? line : indent + INDENT + line))];
  });
};
