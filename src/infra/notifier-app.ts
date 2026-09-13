import { Effect, FileSystem, Path } from "effect";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { PACKAGE_ROOT } from "../paths.ts";
import { run } from "./shell.ts";

/**
 * The build the notifier bundle is made from, pinned by digest.
 *
 * `terminal-notifier` is a real Cocoa app, which is the whole point: an
 * AppleScript call posts as whatever ran it — Script Editor — and there is no
 * flag that changes that. An app bundle posts as itself, so a bundle carrying
 * fabrika's name and icon is the only way the notification carries them too.
 *
 * The digest is checked before anything is unpacked. A release that does not
 * match it is not this build, and the run falls back rather than unzipping it.
 */
export const RELEASE = {
  url: "https://github.com/julienXX/terminal-notifier/releases/download/2.0.0/terminal-notifier-2.0.0.zip",
  sha256: "316e767d979d12adb12c3538931b245108f8b1064af44087414c096cb3376d0c",
} as const;

/**
 * Why the 2017 build and not 3.1.0, which is newer, universal and carries a
 * digest GitHub publishes itself.
 *
 * 3.x posts through `UNUserNotificationCenter`, and macOS refuses to grant a
 * non-notarised app authorisation there — its own signed build fails on this
 * machine exactly as a rebranded one does. 2.0.0 posts through the deprecated
 * `NSUserNotification`, where macOS asks the operator directly and honours the
 * answer. That is the only path a bundle built on the machine it runs on can
 * take today.
 *
 * It is borrowed time, and worth saying so: the binary is x86_64 only, so it
 * runs under Rosetta and macOS already warns about it, and the API it uses is
 * deprecated. When either goes, this stops working and the fallback is the
 * same as it is for every other failure here — the run does not notify. The
 * digest is the one the release has had since 2017, cross-checked against an
 * independent pin; GitHub publishes none for an asset that old.
 */

/** The posting binary, and whatever the operator should be told about getting it. */
export type NotifierApp = { readonly bin?: string; readonly note?: string };

const APP = "Fabrika.app";
const BIN = "Contents/MacOS/terminal-notifier";

/**
 * The bundle fabrika posts through, built once per machine and kept in
 * `~/.fabrika` beside the runs and the worktrees.
 *
 * Every failure here returns a note and no binary, and a run with no binary
 * does not notify at all. There is deliberately no second way to post: the
 * fallback would be an AppleScript call wearing Script Editor's name and
 * icon, and a notification that looks like it came from another app is worse
 * than the run saying nothing. A notification is the last thing a run does
 * and the least important thing it does; nothing about it is allowed to end
 * one, but nothing about it is worth faking either.
 */
export const notifierApp = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const dir = path.join(homedir(), ".fabrika", "notifier");
  const app = path.join(dir, APP);
  const bin = path.join(app, BIN);
  if (yield* fs.exists(bin)) return { bin };

  const icns = path.join(PACKAGE_ROOT, "assets", "fabrika.icns");
  if (!(yield* fs.exists(icns))) return { note: `no icon at ${icns} — this run will not notify` };

  const work = path.join(dir, "build");
  yield* fs.remove(work, { recursive: true, force: true }).pipe(Effect.ignore);
  yield* fs.makeDirectory(work, { recursive: true });

  const zip = path.join(work, "release.zip");
  const bytes = yield* Effect.tryPromise(() =>
    fetch(RELEASE.url).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return new Uint8Array(await r.arrayBuffer());
    }),
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== RELEASE.sha256) {
    return { note: `the notifier release did not match its digest (${digest.slice(0, 12)}…) — this run will not notify` };
  }
  yield* fs.writeFile(zip, bytes);

  // `ditto` rather than `unzip`: it is the one that keeps a bundle's symlinks
  // and permissions intact, and an executable bit lost here is a binary that
  // will not run.
  yield* run(work, ["/usr/bin/ditto", "-xk", zip, work]);
  const unpacked = path.join(work, "terminal-notifier.app");
  if (!(yield* fs.exists(path.join(unpacked, BIN)))) return { note: "the notifier release had no binary where one was expected" };

  // Rebranding is three plist keys and one icon. The signature cannot survive
  // that, so it is dropped here and replaced below: the notification API this
  // release uses refuses to so much as ask for permission from a bundle with
  // no code identity, and fails with `UNErrorDomain error 1` instead.
  yield* fs.remove(path.join(unpacked, "Contents", "_CodeSignature"), { recursive: true, force: true }).pipe(Effect.ignore);
  yield* fs.copyFile(icns, path.join(unpacked, "Contents", "Resources", "Terminal.icns"));
  const plist = path.join(unpacked, "Contents", "Info.plist");
  yield* run(work, [
    "/usr/libexec/PlistBuddy",
    "-c", "Set :CFBundleIdentifier dev.fabrika.notifications",
    "-c", "Set :CFBundleName fabrika",
    "-c", "Set :CFBundleIconFile Terminal",
    plist,
  ]);
  // Added rather than set: the stock plist has no such key, and `Set` on a
  // missing one fails where `Add` on an existing one is merely refused.
  yield* run(work, ["/usr/libexec/PlistBuddy", "-c", "Add :LSUIElement bool true", plist]).pipe(Effect.ignore);

  // Ad-hoc, because there is nothing to sign it with and nothing that needs
  // trusting: it gives the bundle a stable identity of its own, which is all
  // the notification API is asking for. Signed before the move, so a bundle
  // only ever appears at its final path complete.
  yield* run(work, ["/usr/bin/codesign", "--force", "--deep", "--sign", "-", unpacked]);

  yield* fs.remove(app, { recursive: true, force: true }).pipe(Effect.ignore);
  yield* fs.rename(unpacked, app);
  yield* fs.remove(work, { recursive: true, force: true }).pipe(Effect.ignore);
  return { bin, note: `built the notifier bundle in ${dir} — macOS will ask once whether fabrika may notify` };
}).pipe(
  // Whatever went wrong — no network, a read-only home, a missing PlistBuddy —
  // the run keeps its notification and loses only the icon.
  Effect.catchCause((cause): Effect.Effect<NotifierApp> =>
    Effect.succeed({ note: `could not build the notifier bundle (${String(cause).split("\n")[0]?.slice(0, 90)}) — this run will not notify` }),
  ),
);
