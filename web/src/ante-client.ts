// The ante delegate client: GetIdentity / Challenge / Commit, over CBOR
// delegate messaging. The protocol is pinned in `ante_core::protocol`.

import { asBytes, asString, cborDecode, cborEncode, CborValue, enumVariant, mapGet } from "./cbor";
import { decodeAnteProof, type AnteProof } from "./ante-proof";
import { sendToDelegate, type DelegateAddress } from "./delegate-api";
import type { FreenetClient } from "./freenet";

/// The node blocks a `Commit` request while the consent prompt is on screen —
/// up to exactly 60 s (`USER_INPUT_TIMEOUT` in freenet-core), then auto-denies.
/// There is no intermediate signal; the one response carries the final
/// outcome. Wait a little past the node's own window.
const COMMIT_TIMEOUT_MS = 75_000;

export type CommitOutcome =
  | { kind: "committed"; proof: AnteProof; proofCbor: Uint8Array }
  | { kind: "denied" };

export class AnteClient {
  constructor(
    private readonly client: FreenetClient,
    private readonly delegate: DelegateAddress,
  ) {}

  /// This origin's identity verifying key (created on first call). No prompt.
  async getIdentity(): Promise<Uint8Array> {
    const reply = await this.oneShot("GetIdentity");
    expect(reply.variant, "Identity");
    return asBytes(mapGet(reply.fields!, "verifying_key"));
  }

  /// The grind preimage for `purpose`. Feed it to the worker. No prompt.
  async challenge(purpose: string): Promise<Uint8Array> {
    const reply = await this.oneShot({ Challenge: { purpose } });
    expect(reply.variant, "Challenge");
    return asBytes(mapGet(reply.fields!, "bytes"));
  }

  /// Origins that hold an "always allow" grant. No prompt.
  async listGrants(): Promise<Uint8Array[]> {
    const reply = await this.oneShot("ListGrants");
    expect(reply.variant, "Grants");
    const origins = mapGet(reply.fields!, "origins");
    return Array.isArray(origins) ? origins.map((o) => asBytes(o)) : [];
  }

  /// Remove one "always allow" grant, or all when `origin` is null. No prompt.
  async revokeGrant(origin: Uint8Array | null): Promise<void> {
    const req: CborValue = { RevokeGrant: { origin: origin ? Array.from(origin) : null } };
    const reply = await this.oneShot(req);
    expect(reply.variant, "Revoked");
  }

  /// Ask the user to authorize spending the identity on `purpose`, and on
  /// approval get back a signed proof. The node shows the consent prompt in
  /// every open Freenet tab and holds this request open until the user answers
  /// (or 60 s elapses → `denied`). `onPending` fires once the request is in
  /// flight so the UI can say "approve the prompt".
  async commit(
    purpose: string,
    nonce: number,
    minBits: number,
    onPending?: () => void,
  ): Promise<CommitOutcome> {
    const request: CborValue = {
      Commit: { purpose, nonce, min_bits: minBits, ts: Date.now() },
    };
    onPending?.();
    const reply = await sendToDelegate(
      this.client,
      this.delegate,
      cborEncode(request),
      COMMIT_TIMEOUT_MS,
    );
    if (reply.payloads.length === 0) {
      throw new Error("no response from the delegate for the commit");
    }
    return this.interpretCommit(reply.payloads[0]);
  }

  private interpretCommit(payload: Uint8Array): CommitOutcome {
    const reply = enumVariant(cborDecode(payload));
    if (reply.variant === "Denied") return { kind: "denied" };
    if (reply.variant === "Error") {
      throw new Error(`ante delegate: ${asString(mapGet(reply.fields!, "message"))}`);
    }
    expect(reply.variant, "Committed");
    const proofCbor = asBytes(mapGet(reply.fields!, "proof"));
    return { kind: "committed", proof: decodeAnteProof(proofCbor), proofCbor };
  }

  private async oneShot(request: CborValue): Promise<{ variant: string; fields: CborValue | null }> {
    const reply = await sendToDelegate(this.client, this.delegate, cborEncode(request));
    if (reply.payloads.length === 0) {
      throw new Error("ante delegate returned no response");
    }
    const parsed = enumVariant(cborDecode(reply.payloads[0]));
    if (parsed.variant === "Error") {
      throw new Error(`ante delegate: ${asString(mapGet(parsed.fields!, "message"))}`);
    }
    return parsed;
  }
}

function expect(got: string, want: string): void {
  if (got !== want) throw new Error(`expected ${want} response, got ${got}`);
}
