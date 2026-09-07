// ─────────────────────────────────────────────────────────────────────────
//  Normal Freenet code. No ante in this file.
//
//  This is what a client for *any* Freenet contract looks like: CBOR wire
//  types that mirror the Rust structs, a GET to read state, a delta UPDATE to
//  append. The `proof` field happens to be an ante proof, but as far as this
//  file is concerned it is just another part of the record.
// ─────────────────────────────────────────────────────────────────────────

import { blake3 } from "@noble/hashes/blake3.js";

import deployments from "../../../../deployments.json";

import {
  anteProofToCborValue,
  asString,
  cborDecode,
  cborEncode,
  contractKeyFromId,
  decodeAnteProofValue,
  bytesToHex,
  concatBytes,
  mapGet,
  u32le,
  type AnteProof,
  type CborValue,
  type FreenetClient,
} from "@ante/client";

/// The published guestbook contract instance, from the repository's
/// deployments.json so this address lives in exactly one place. Baked in at
/// BUILD time and NOT overridable at runtime.
///
/// A `?contract=<id>` parameter would let anyone hand out a link that is the
/// genuine guestbook — genuine address, genuine code — showing data they
/// control. The address bar would vouch for content the owner never published.
///
/// So the pointer is this constant, and the authority to move it is the
/// website's publisher key: changing where the app reads from means
/// republishing the site, which only the key holder can do. That is the same
/// trust root, with nothing extra to run. To point a local build somewhere
/// else, edit this line and rebuild.
const GUESTBOOK_CONTRACT_ID = deployments.contracts.guestbook.instance;

/// Must match the parameters the contract was published with
/// (`ANTE_GUESTBOOK_PURPOSE` / `ANTE_GUESTBOOK_MIN_BITS` in the publish script).
export const GUESTBOOK_PURPOSE = "ante-guestbook:post:v1";
export const GUESTBOOK_MIN_BITS = 16;

export const MAX_NAME_BYTES = 40;
export const MAX_TEXT_BYTES = 500;

/// The `purpose` a proof must carry to count for one specific message —
/// mirrors `content_purpose` in the contract, and the two are pinned against
/// each other by the shared wire vector.
///
/// Without this, a proof commits to (identity, purpose, nonce) and nothing
/// else, so a single grind validates unlimited different posts — and since the
/// challenge is fixed per (purpose, identity) and grinding starts at nonce 0,
/// the author re-finds the same nonce for free every time. Folding the message
/// in gives every post its own challenge and its own real search.
export function contentPurpose(name: string, text: string): string {
  const enc = new TextEncoder();
  const n = enc.encode(name);
  const t = enc.encode(text);
  const tag = blake3(concatBytes(u32le(n.length), n, u32le(t.length), t));
  return `${GUESTBOOK_PURPOSE}:${bytesToHex(tag.slice(0, 8))}`;
}

export function contractId(): string {
  return GUESTBOOK_CONTRACT_ID;
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
    const bytes = await this.fn.getContractState(this.key);
    // A contract with no updates yet has empty state (the Rust side maps that
    // to GuestbookState::default()). Nothing to decode.
    if (bytes.length === 0) return [];
    const map = mapGet(cborDecode(bytes), "entries");
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
