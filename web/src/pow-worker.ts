// Runs the grind off the main thread and reports progress so the UI can show
// a live hash counter and an elapsed estimate.

import { powBits } from "./pow";

export interface PowWorkerRequest {
  challenge: Uint8Array;
  targetBits: number;
}

export type PowWorkerMessage =
  | { type: "progress"; tried: number }
  | { type: "done"; nonce: number; tried: number };

const PROGRESS_EVERY = 4096;

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PowWorkerRequest>) => void) | null;
  postMessage(message: PowWorkerMessage): void;
};

scope.onmessage = (event) => {
  const { challenge, targetBits } = event.data;
  let nonce = 0;
  for (;;) {
    for (let i = 0; i < PROGRESS_EVERY; i++, nonce++) {
      if (powBits(challenge, nonce) >= targetBits) {
        scope.postMessage({ type: "done", nonce, tried: nonce + 1 });
        return;
      }
    }
    scope.postMessage({ type: "progress", tried: nonce });
  }
};
