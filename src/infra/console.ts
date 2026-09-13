import { plain, type RunEvent } from "../run-event.ts";

/** The stateful owner of one output surface. One per surface; only the console's animates. */
export type Presenter = {
  readonly show: (event: RunEvent | string) => void;
  readonly end: () => void;
};

export type ConsoleOptions = {
  readonly stream: NodeJS.WriteStream;
  readonly interactive?: boolean;
  readonly now?: () => number;
};

const stamp = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour12: false });

/**
 * A presenter over a stream. Dependencies are handed in rather than reached
 * for, so a test can drive a scripted run into an in-memory sink and `init`
 * can build one with no run directory behind it.
 */
export const openConsole = (options: ConsoleOptions): Presenter => {
  const now = options.now ?? Date.now;
  let ended = false;

  const show = (event: RunEvent | string) => {
    for (const line of plain(event)) options.stream.write(`${stamp(now())} ${line}\n`);
  };

  const end = () => {
    if (ended) return;
    ended = true;
  };

  return { show, end };
};
