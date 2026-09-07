import { describe, expect, it } from "vitest";

import { bytesToHex, cborDecode, cborEncode, hexToBytes, mapGet } from "@ante/client";

import { contentPurpose, decodeEntry, encodeEntry, entriesInState } from "../src/guestbook";
import { carryableEntries } from "../src/ante";

// The exact bytes `ante-guestbook-contract`'s `delta_cbor_wire_format_is_pinned`
// pins on the Rust side. This test proves the web client's decode → encode
// round-trip lands on the same bytes, so a post from the browser is a delta the
// contract accepts. If the contract's `Entry` layout changes, both hexes move
// together or this fails.
const PINNED_DELTA_HEX =
  "a167656e747269657381a3646e616d6565616c69636564746578746568656c6c6f6570726f6f66a56b6964656e746974795f766b982018ea184a186c186318e2189c18520a18be18f51850187b13182e18c518f918951847187618ae18be18be187b18921842181e18ea186914184618d2182c67707572706f73657827616e74652d6775657374626f6f6b3a706f73743a76323a34333731306633666431373037343835656e6f6e636519fb8c6274731b00000191dd9dec00697369676e6174757265984018cd186e187a0b18e71518941118f018ba18c418240b0e0c18cc18fb186818c5183e18d5184218dd18aa181c187818da18bf185218351854188a18971829184818a5183f18f00e187b1318fb1821185b1876186918bb182918b218721833188718ad182e18c2181d1891184818dc1867189e18e318fa03";

describe("guestbook wire format", () => {
  it("decode → encode round-trips to the bytes the contract pins", () => {
    const delta = cborDecode(hexToBytes(PINNED_DELTA_HEX));
    const list = mapGet(delta, "entries");
    if (!Array.isArray(list)) throw new Error("expected an entries array");

    const rebuilt = cborEncode({ entries: list.map((v) => encodeEntry(decodeEntry(v))) });
    expect(bytesToHex(rebuilt)).toBe(PINNED_DELTA_HEX);
  });

  it("decodes the entry fields", () => {
    const delta = cborDecode(hexToBytes(PINNED_DELTA_HEX));
    const list = mapGet(delta, "entries");
    if (!Array.isArray(list)) throw new Error("expected an entries array");
    const entry = decodeEntry(list[0]);

    expect(entry.name).toBe("alice");
    expect(entry.text).toBe("hello");
    // The Rust side built this vector with its own `content_purpose`. If the
    // TypeScript mirror ever drifts, every post from the browser starts being
    // rejected by the contract — so pin the two against each other here.
    expect(entry.proof.purpose).toBe(contentPurpose("alice", "hello"));
    expect(entry.proof.purpose.startsWith("ante-guestbook:post:v2:")).toBe(true);
    expect(entry.proof.identityVk).toHaveLength(32);
    expect(entry.proof.signature).toHaveLength(64);
  });
});

describe("content binding", () => {
  it("gives every distinct message its own purpose", () => {
    expect(contentPurpose("alice", "hello")).not.toBe(contentPurpose("alice", "hello!"));
    expect(contentPurpose("alice", "hello")).not.toBe(contentPurpose("alicia", "hello"));
    // length-prefixed, so the fields cannot be re-split
    expect(contentPurpose("ab", "c")).not.toBe(contentPurpose("a", "bc"));
  });

  it("stays inside the purpose length cap", () => {
    expect(contentPurpose("x".repeat(40), "y".repeat(500)).length).toBeLessThanOrEqual(256);
  });
});

describe("carry-forward across a re-key", () => {
  const delta = cborDecode(hexToBytes(PINNED_DELTA_HEX));
  const list = mapGet(delta, "entries") as unknown[];
  const good = decodeEntry(list[0] as never);

  it("reads entries out of a predecessor's raw state", () => {
    const levels = new Map<unknown, unknown>();
    levels.set(Array.from(good.proof.identityVk), encodeEntry(good));
    const state = cborEncode({ entries: levels } as never);
    expect(entriesInState(state).map((e) => e.text)).toEqual([good.text]);
  });

  it("returns nothing for an empty or undecodable state", () => {
    expect(entriesInState(new Uint8Array())).toEqual([]);
    expect(entriesInState(cborEncode({ nope: 1 }))).toEqual([]);
  });

  it("drops entries whose proof is not bound to their message", () => {
    // What every entry looked like before the content-binding fix: a bare
    // purpose, valid then, inadmissible now. Carrying it would reopen "one
    // grind buys unlimited posts", so the sweep must drop it — and must not
    // report the generation as merely empty.
    const legacy = {
      ...good,
      proof: { ...good.proof, purpose: "ante-guestbook:post:v2" },
    };
    const { carryable, dropped } = carryableEntries([good, legacy]);
    expect(carryable).toHaveLength(1);
    expect(carryable[0].text).toBe(good.text);
    expect(dropped).toBe(1);
  });

  it("drops an entry whose text was altered after signing", () => {
    const tampered = { ...good, text: good.text + "!" };
    expect(carryableEntries([tampered]).dropped).toBe(1);
  });
});
