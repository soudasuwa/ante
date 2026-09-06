// Runs the grind off the main thread and reports progress so the UI can show a
// live hash counter and rate.

import { Grinder } from "./pow";

export interface PowWorkerRequest {
  challenge: Uint8Array;
  targetBits: number;
}

export type PowWorkerMessage =
  | { type: "progress"; tried: number }
  | { type: "done"; nonce: number; tried: number };

const BATCH = 4096;

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PowWorkerRequest>) => void) | null;
  postMessage(message: PowWorkerMessage): void;
};

scope.onmessage = (event) => {
  const { challenge, targetBits } = event.data;
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
