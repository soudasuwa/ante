// ─────────────────────────────────────────────────────────────────────────
//  Normal Freenet code. No ante in this file.
//
//  This is what a client for *any* Freenet contract looks like: CBOR wire
//  types that mirror the Rust structs, a GET to read state, a delta UPDATE to
//  append. The `proof` field happens to be an ante proof, but as far as this
//  file is concerned it is just another part of the record.
// ─────────────────────────────────────────────────────────────────────────

import {
  anteProofToCborValue,
  asString,
  cborDecode,
  cborEncode,
  contractKeyFromId,
  decodeAnteProofValue,
  mapGet,
  type AnteProof,
  type CborValue,
  type FreenetClient,
} from "@ante/client";

/// The published guestbook contract instance. Fill this in after
/// `scripts/publish-guestbook.sh` prints the id, or pass `?contract=<id>`.
const GUESTBOOK_CONTRACT_ID = "";

/// Must match the parameters the contract was published with
/// (`ANTE_GUESTBOOK_PURPOSE` / `ANTE_GUESTBOOK_MIN_BITS` in the publish script).
export const GUESTBOOK_PURPOSE = "ante-guestbook:post:v1";
export const GUESTBOOK_MIN_BITS = 16;

export const MAX_NAME_BYTES = 40;
export const MAX_TEXT_BYTES = 500;

export function contractId(): string {
  return new URLSearchParams(location.search).get("contract") ?? GUESTBOOK_CONTRACT_ID;
}

/// One guestbook entry — mirrors `Entry` in the contract crate.
export interface Entry {
  name: string;
  text: string;
  proof: AnteProof;
}

export function encodeEntry(entry: Entry): CborValue {
  return { name: entry.name, text: entry.text, proof: anteProofToCborValue(entry.proof) };
}

export function decodeEntry(value: CborValue | undefined): Entry {
  return {
    name: asString(mapGet(value, "name")),
    text: asString(mapGet(value, "text")),
    proof: decodeAnteProofValue(mapGet(value, "proof")),
  };
}

export class Guestbook {
  private readonly key = contractKeyFromId(contractId());

  constructor(private readonly fn: FreenetClient) {}

  /// Read every entry from contract state. The contract stores them in a
  /// `BTreeMap` keyed by a content hash; the client only cares about the values.
  async entries(): Promise<Entry[]> {
    const state = cborDecode(await this.fn.getContractState(this.key));
    const map = mapGet(state, "entries");
    if (!(map instanceof Map)) return [];
    return [...map.values()].map(decodeEntry);
  }

  /// Append one entry with a delta UPDATE (`GuestbookDelta { entries }`). The
  /// contract re-checks the proof on the way in, so a bad one is rejected here.
  async post(entry: Entry): Promise<void> {
    const delta = cborEncode({ entries: [encodeEntry(entry)] });
    await this.fn.updateContractDelta(this.key, delta);
  }
}
