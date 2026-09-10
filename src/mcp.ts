import { FileSystem, Path } from "@effect/platform";
import { Data, Effect, Schema } from "effect";
import { homedir, tmpdir } from "node:os";

/**
 * Claude Code's own config is the registry. Servers are added once with
 * `claude mcp add`; a stage names the ones it wants and we hand the CLI a
 * file holding only those.
 *
 * We resolve rather than let the CLI auto-discover because local-scope
 * servers are keyed by project path, and the agent runs in a worktree at a
 * different path — it would never see them.
 *
 * This reads config, not credentials: OAuth tokens live in the keychain.
 */
const McpServer = Schema.Struct({
  type: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
});
export type McpServer = typeof McpServer.Type;

const Servers = Schema.Record({ key: Schema.String, value: McpServer });

const ClaudeJson = Schema.Struct({
  mcpServers: Schema.optional(Servers),
  projects: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Struct({ mcpServers: Schema.optional(Servers) }) }),
  ),
});

const ProjectMcpJson = Schema.Struct({ mcpServers: Schema.optional(Servers) });

export class McpServerNotFound extends Data.TaggedError("McpServerNotFound")<{
  readonly name: string;
  readonly repoRoot: string;
}> {}

export class McpServerNeedsStaticAuth extends Data.TaggedError("McpServerNeedsStaticAuth")<{
  readonly name: string;
  readonly url: string;
}> {}

/** Missing file → empty; a present-but-broken file still fails loudly. */
const readJsonOrEmpty = <A, I>(schema: Schema.Schema<A, I>, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(file))) return undefined;
    const raw = yield* fs.readFileString(file);
    return yield* Schema.decodeUnknown(Schema.parseJson(schema), { onExcessProperty: "ignore" })(raw);
  });

/** user < project (.mcp.json) < local, matching the CLI's own precedence. */
export const allServers = (repoRoot: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const claudeJson = yield* readJsonOrEmpty(ClaudeJson, path.join(homedir(), ".claude.json"));
    const projectJson = yield* readJsonOrEmpty(ProjectMcpJson, path.join(repoRoot, ".mcp.json"));
    return {
      ...claudeJson?.mcpServers,
      ...projectJson?.mcpServers,
      ...claudeJson?.projects?.[repoRoot]?.mcpServers,
    } as Record<string, McpServer>;
  });

export const resolveServers = (repoRoot: string, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const all = yield* allServers(repoRoot);
    const picked: Record<string, McpServer> = {};
    for (const name of names) {
      const server = all[name];
      if (!server) return yield* new McpServerNotFound({ name, repoRoot });
      const remote = !!server.url && !server.command;
      if (remote && !server.headers?.Authorization) {
        return yield* new McpServerNeedsStaticAuth({ name, url: server.url! });
      }
      picked[name] = server;
    }
    return picked;
  });

/**
 * A 0600 file so the bearer header never appears in `ps`. Scoped: it is
 * removed when the enclosing scope closes, whatever path the run took.
 */
export const mcpConfigFile = (servers: Record<string, McpServer>) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(tmpdir(), `fabrika-mcp-${process.pid}-${Date.now()}.json`);
      yield* fs.writeFileString(file, JSON.stringify({ mcpServers: servers }));
      yield* fs.chmod(file, 0o600);
      return file;
    }),
    (file) => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(file).pipe(Effect.ignore);
    }),
  );
