// The ante integration. This is the whole ante-specific surface a producer app
// touches: attach the delegate, then `commit(purpose)` — challenge, grind, and
// the consent prompt are handled inside.
//
// The wire protocol is pinned in `ante_core::protocol`.

import { decodeAnteProof, type AnteProof } from "./ante-proof";
import { asBytes, asString, cborDecode, cborEncode, CborValue, enumVariant, mapGet } from "./cbor";
import {
  ANTE_DELEGATE_CODE_HASH_BYTES,
  ANTE_DELEGATE_KEY_BYTES,
  ANTE_DELEGATE_WASM_B64,
  delegateEmbedded,
} from "./embedded";
import {
  base64ToBytes,
  registerDelegate,
  sendToDelegate,
  type DelegateAddress,
} from "./delegate-msg";
import type { FreenetClient } from "./freenet";
import PowWorker from "./pow-worker?worker&inline";
import type { PowWorkerMessage, PowWorkerRequest } from "./pow-worker";

/// The node holds a `Commit` request open while the consent prompt is on
/// screen — up to exactly 60 s (`USER_INPUT_TIMEOUT` in freenet-core), then
/// auto-denies. Wait a little past that.
const COMMIT_TIMEOUT_MS = 75_000;

export type CommitOutcome =
  | { kind: "committed"; proof: AnteProof; bytes: Uint8Array }
  | { kind: "denied" };

export interface CommitOptions {
  /// Minimum leading-zero bits to grind for. Default 18.
  minBits?: number;
  /// Called with (hashesTried, hashesPerSecond) during the grind.
  onProgress?: (tried: number, hps: number) => void;
  /// Called just before the commit goes to the node; the consent prompt
  /// appears there a moment later. There is no signal for the prompt itself —
  /// the node holds the request open and sends one response after the user
  /// answers.
  onPrompt?: () => void;
}

export class AnteClient {
  private constructor(
    private readonly client: FreenetClient,
    private readonly delegate: DelegateAddress,
  ) {}

  /// Register the ante delegate on the node and return a client. The delegate
  /// WASM is embedded in this package — nothing to host or configure.
  static async attach(client: FreenetClient): Promise<AnteClient> {
    if (!delegateEmbedded()) {
      throw new Error("ante delegate not embedded — run scripts/sync-delegate.sh in the ante repo");
    }
    const address: DelegateAddress = {
      keyBytes: ANTE_DELEGATE_KEY_BYTES,
      codeHashBytes: ANTE_DELEGATE_CODE_HASH_BYTES,
    };
    await registerDelegate(client, address, base64ToBytes(ANTE_DELEGATE_WASM_B64));
    return new AnteClient(client, address);
  }

  /// The user's identity verifying key (32 bytes), created on first call. No
  /// prompt.
  async identity(): Promise<Uint8Array> {
    const reply = await this.oneShot("GetIdentity");
    expect(reply.variant, "Identity");
    return asBytes(mapGet(reply.fields!, "verifying_key"));
  }

  /// Grind proof of work against `purpose` and, with the user's consent, get
  /// back a signed proof. `outcome.bytes` is the CBOR to attach to a contract
  /// write; `outcome.proof` is the decoded form.
  async commit(purpose: string, opts: CommitOptions = {}): Promise<CommitOutcome> {
    const minBits = opts.minBits ?? 18;
    const challenge = await this.challenge(purpose);
    const nonce = await grindInWorker(challenge, minBits, opts.onProgress);
    return this.signCommit(purpose, nonce, minBits, opts.onPrompt);
  }

  /// The challenge preimage for `purpose` — for callers running their own
  /// grinder. Grind `blake3(bytes ‖ nonce_le)`, count leading zero bits.
  async challenge(purpose: string): Promise<Uint8Array> {
    const reply = await this.oneShot({ Challenge: { purpose } });
    expect(reply.variant, "Challenge");
    return asBytes(mapGet(reply.fields!, "bytes"));
  }

  /// Low-level: sign a proof over a nonce you already ground.
  async signCommit(
    purpose: string,
    nonce: number,
    minBits: number,
    onPrompt?: () => void,
  ): Promise<CommitOutcome> {
    const request: CborValue = { Commit: { purpose, nonce, min_bits: minBits, ts: Date.now() } };
    onPrompt?.();
    const reply = await sendToDelegate(
      this.client,
      this.delegate,
      cborEncode(request),
      COMMIT_TIMEOUT_MS,
    );
    if (reply.payloads.length === 0) throw new Error("no response from the delegate for the commit");

    const parsed = enumVariant(cborDecode(reply.payloads[0]));
    if (parsed.variant === "Denied") return { kind: "denied" };
    if (parsed.variant === "Error") {
      throw new Error(`ante delegate: ${asString(mapGet(parsed.fields!, "message"))}`);
    }
    expect(parsed.variant, "Committed");
    const bytes = asBytes(mapGet(parsed.fields!, "proof"));
    return { kind: "committed", proof: decodeAnteProof(bytes), bytes };
  }

  /// Origins that hold an "always allow" grant. For a managing UI.
  async listGrants(): Promise<Uint8Array[]> {
    const reply = await this.oneShot("ListGrants");
    expect(reply.variant, "Grants");
    const origins = mapGet(reply.fields!, "origins");
    return Array.isArray(origins) ? origins.map((o) => asBytes(o)) : [];
  }

  /// Remove one "always allow" grant, or all when `origin` is null.
  async revokeGrant(origin: Uint8Array | null): Promise<void> {
    const req: CborValue = { RevokeGrant: { origin: origin ? Array.from(origin) : null } };
    const reply = await this.oneShot(req);
    expect(reply.variant, "Revoked");
  }

  private async oneShot(request: CborValue): Promise<{ variant: string; fields: CborValue | null }> {
    const reply = await sendToDelegate(this.client, this.delegate, cborEncode(request));
    if (reply.payloads.length === 0) throw new Error("ante delegate returned no response");
    const parsed = enumVariant(cborDecode(reply.payloads[0]));
    if (parsed.variant === "Error") {
      throw new Error(`ante delegate: ${asString(mapGet(parsed.fields!, "message"))}`);
    }
    return parsed;
  }
}

function grindInWorker(
  challenge: Uint8Array,
  targetBits: number,
  onProgress?: (tried: number, hps: number) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new PowWorker();
    const started = performance.now();
    worker.onmessage = (event: MessageEvent<PowWorkerMessage>) => {
      const msg = event.data;
      const elapsed = (performance.now() - started) / 1000;
      onProgress?.(msg.tried, elapsed > 0 ? msg.tried / elapsed : 0);
      if (msg.type === "done") {
        worker.terminate();
        resolve(msg.nonce);
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "grind worker failed"));
    };
    worker.postMessage({ challenge, targetBits } satisfies PowWorkerRequest);
  });
}

function expect(got: string, want: string): void {
  if (got !== want) throw new Error(`expected ${want} response, got ${got}`);
}
