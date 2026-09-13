import type { Presenter } from "./console.ts";
import { detached, withoutSecrets } from "./shell.ts";
import type { RunEvent } from "../run-event.ts";

export type NotifierOptions = {
  /** What the notification is from; the ticket, because an operator runs more than one. */
  readonly title: string;
  /**
   * The rebranded bundle to post through. There is no second way to post: a
   * notification wearing another app's name and icon is worse than the run
   * saying nothing, so a machine without a bundle gets no notification.
   */
  readonly bin?: string;
  /** Injected by the tests, so nothing here posts a real notification. */
  readonly post?: (text: string, title: string) => void;
};

/** The bundle's own CLI. It posts as the bundle, which is where the icon comes from. */
const viaApp = (bin: string) => (text: string, title: string) =>
  detached(bin, ["-title", title, "-message", text], withoutSecrets(process.env));


/**
 * The mark the title opens with.
 *
 * Notification Center takes its icon from whichever app posted, and for a CLI
 * that is whatever ran the AppleScript — a custom one needs a signed, notarised
 * app bundle, which a package installed from npm does not have. So the outcome
 * is carried in the only channel that is left. It is one glyph in a title read
 * at arm's length, not decoration on a log line.
 */
// Chosen to be unmistakable at title size: a mark that renders as a bare
// square reads as a font that failed, not as an outcome. U+FE0F on the
// warning sign for the same reason — it defaults to text presentation.
const MARK = { done: "\u2705", escalated: "\u26A0\uFE0F", stopped: "\uD83D\uDED1" } as const;

/**
 * The surface that reports a run once, when it is over.
 *
 * A presenter like any other, which is what lets it see outcomes no `result`
 * event describes: `end` is the journal layer's finaliser, and that closes on
 * every way out — the done line, an escalation, a usage limit, a crash, a
 * Ctrl-C. The ones with no event of their own say only that the run stopped,
 * because the terminal is where the reason is.
 *
 * Armed by the `run` event rather than by being constructed: a rerun of a
 * finished ticket short-circuits before the pipeline emits one, and a
 * notification for a run that never started is noise.
 */
export const openNotifier = (options: NotifierOptions): Presenter => {
  const post = options.post ?? (options.bin ? viaApp(options.bin) : undefined);
  let started = false;
  let result: { readonly outcome: "done" | "escalated"; readonly text: string } | undefined;
  return {
    show: (entry: RunEvent | string) => {
      if (typeof entry === "string") return;
      if (entry.kind === "run") started = true;
      if (entry.kind === "result") result = { outcome: entry.outcome, text: entry.text };
    },
    end: () => {
      if (!started || !post) return;
      // Once: `end` is called from a finaliser, and a layer released twice
      // would otherwise post the same outcome twice.
      started = false;
      const mark = MARK[result?.outcome ?? "stopped"];
      post(result?.text ?? "stopped before finishing — see the terminal", `${mark} ${options.title}`);
    },
  };
};
