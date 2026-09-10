/**
 * Keeps `.claude-plugin/plugin.json` in step with package.json's version.
 *
 * Wired to npm's `version` lifecycle, which runs after the bump and before the
 * commit npm creates, so staging the manifest here folds it into that same
 * commit. Nothing reads the manifest's version — `--plugin-dir` only needs
 * `name` — but a manifest claiming a version the package never shipped is a
 * lie that costs nothing to avoid.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const pkgPath = fileURLToPath(new URL("package.json", root));
const manifestPath = fileURLToPath(new URL(".claude-plugin/plugin.json", root));

const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));

if (typeof pkg !== "object" || pkg === null || !("version" in pkg) || typeof pkg.version !== "string") {
  throw new Error(`${pkgPath}: no string "version"`);
}
if (typeof manifest !== "object" || manifest === null) {
  throw new Error(`${manifestPath}: not an object`);
}

const version = pkg.version;
const record = manifest as Record<string, unknown>;

if (record["version"] === version) {
  console.log(`plugin.json already at ${version}`);
} else {
  record["version"] = version;
  writeFileSync(manifestPath, `${JSON.stringify(record, null, 2)}\n`);
  execFileSync("git", ["add", manifestPath]);
  console.log(`plugin.json -> ${version}`);
}
