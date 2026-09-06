// The ante delegate client: GetIdentity / Challenge / Commit, over CBOR
// delegate messaging. The protocol is pinned in `ante_core::protocol`.

import { asBytes, asString, cborDecode, cborEncode, CborValue, enumVariant, mapGet } from "./cbor";
import { decodeAnteProof, type AnteProof } from "./ante-proof";
import { awaitPromptResult, sendToDelegate, type DelegateAddress } from "./delegate-api";
import type { FreenetClient } from "./freenet";

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

  /// Ask the user to authorize spending this identity on `purpose`, and on
  /// approval get back a signed proof. Raises the shell consent prompt; the
  /// returned promise resolves only after the user answers it.
  async commit(
    purpose: string,
    nonce: number,
    minBits: number,
    onPrompt?: () => void,
  ): Promise<CommitOutcome> {
    const request: CborValue = {
      Commit: { purpose, nonce, min_bits: minBits, ts: Date.now() },
    };
    const reply = await sendToDelegate(this.client, this.delegate, cborEncode(request));

    // The delegate rejected the nonce (or the request) before prompting.
    if (reply.payloads.length > 0) {
      return this.interpretCommit(reply.payloads[0]);
    }
    if (!reply.raisedPrompt) {
      throw new Error("delegate returned neither a prompt nor a response");
    }

    // Prompt is on screen in every open Freenet tab. Wait for the answer.
    onPrompt?.();
    const payloads = await awaitPromptResult(this.client, this.delegate);
    if (payloads.length === 0) throw new Error("no response after the consent prompt");
    return this.interpretCommit(payloads[0]);
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
