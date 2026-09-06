// Runs the grind off the main thread so the UI stays live.
//
// Two modes, matching the two ways an app asks for work:
//
//   targetBits set    grind to that bar, reporting progress, then `done`.
//   targetBits unset  grind open-ended, reporting every improvement as `best`,
//                     until the caller terminates the worker. This is what lets
//                     a UI show the commitment climbing and hand the user the
//                     decision of when it is enough.

import { Grinder } from "./pow";

export interface PowWorkerRequest {
  challenge: Uint8Array;
  /// Omit for open-ended grinding.
  targetBits?: number;
}

export type PowWorkerMessage =
  | { type: "progress"; tried: number }
  | { type: "best"; nonce: number; bits: number; tried: number }
  | { type: "done"; nonce: number; tried: number };

const BATCH = 4096;

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PowWorkerRequest>) => void) | null;
  postMessage(message: PowWorkerMessage): void;
};

scope.onmessage = (event) => {
  const { challenge, targetBits } = event.data;

  if (targetBits === undefined) {
    // Open-ended. Nothing here stops the loop; the caller terminates the worker.
    const grinder = new Grinder(challenge);
    let best = -1;
    for (;;) {
      const hit = grinder.nextBest(BATCH, best);
      if (hit) {
        best = hit.bits;
        scope.postMessage({ type: "best", ...hit, tried: grinder.tried });
      } else {
        scope.postMessage({ type: "progress", tried: grinder.tried });
      }
    }
  }

  const grinder = new Grinder(challenge, targetBits);
  for (;;) {
    const hit = grinder.next(BATCH);
    if (hit !== null) {
      scope.postMessage({ type: "done", nonce: hit, tried: grinder.tried });
      return;
    }
    scope.postMessage({ type: "progress", tried: grinder.tried });
  }
};
