// SPDX-License-Identifier: MIT
// The playground's simulator in a worker of its own: the page can stop a test that never ends and stays usable.
import { play } from "./play.js";

self.onmessage = async (e: MessageEvent<{ file: string; source: string; test: string }>) => {
  const { file, source, test } = e.data;
  try {
    postMessage({ ok: await play(file, source, test) });
  } catch (err) {
    postMessage({ error: String((err as Error)?.message ?? err) });
  }
};
