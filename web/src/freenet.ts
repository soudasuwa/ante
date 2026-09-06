// Connection to the local Freenet node, trimmed to what ante needs: delegate
// registration and delegate messaging. Adapted from FreePlace's freenet-api.ts.
//
// The WS URL follows the page location so the gateway-served app talks to
// whatever node serves it. `?node=host:port` overrides it for `vite dev`,
// which runs on its own origin.

import { DelegateResponse, FreenetWsApi } from "@freenetorg/freenet-stdlib";

import { bytesToHex } from "./util";

export function wsApiUrl(): URL {
  const override = new URLSearchParams(location.search).get("node");
  const host = override ?? location.host;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return new URL(`${proto}://${host}/v1/contract/command`);
}

export interface FreenetEvents {
  onOpen: () => void;
  onClose: (code: number, reason: string) => void;
}

/// Owns the socket plus a queue of waiters for delegate responses. Delegate
/// requests have no promise API in stdlib TS 0.2.0, so responses arrive
/// through the shared handler and are matched to waiters by delegate key
/// (host errors carry no key and go oldest-first).
export class FreenetClient {
  readonly api: FreenetWsApi;
  private pending: Array<{
    keyHex: string | null;
    resolve: (r: DelegateResponse) => void;
    reject: (e: Error) => void;
  }> = [];

  constructor(events: FreenetEvents) {
    this.api = new FreenetWsApi(
      wsApiUrl(),
      {
        onContractPut: () => {},
        onContractGet: () => {},
        onContractUpdate: () => {},
        onContractUpdateNotification: () => {},
        onContractNotFound: () => this.failOldest(new Error("contract not found")),
        onDelegateResponse: (response: DelegateResponse) => {
          const key =
            response.key?.key?.length ? bytesToHex(Uint8Array.from(response.key.key)) : null;
          let index = key
            ? this.pending.findIndex((e) => e.keyHex === null || e.keyHex === key)
            : 0;
          if (index < 0) index = 0;
          this.pending.splice(index, 1)[0]?.resolve(response);
        },
        onErr: (err) => this.failOldest(new Error(err.cause)),
        onOpen: events.onOpen,
        onClose: (code: number, reason: string) => {
          this.failOldest(new Error(`connection closed: ${reason || code}`));
          events.onClose(code, reason);
        },
      },
      // Empty auth token: in the gateway iframe the shell owns auth.
      "",
    );
  }

  private failOldest(err: Error): void {
    this.pending.shift()?.reject(err);
  }

  /// Register a waiter for the next delegate response scoped to `keyBytes`.
  /// Register *before* sending so the response cannot race the registration.
  awaitDelegateResponse(keyBytes?: number[], timeoutMs = 15_000): Promise<DelegateResponse> {
    return new Promise((resolve, reject) => {
      const entry = {
        keyHex: keyBytes?.length ? bytesToHex(Uint8Array.from(keyBytes)) : null,
        resolve: (r: DelegateResponse) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        const i = this.pending.indexOf(entry);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new Error("delegate request timed out"));
      }, timeoutMs);
      this.pending.push(entry);
    });
  }
}
