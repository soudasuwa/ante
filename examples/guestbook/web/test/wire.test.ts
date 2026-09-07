import { describe, expect, it } from "vitest";

import { bytesToHex, cborDecode, cborEncode, hexToBytes, mapGet } from "@ante/client";

import { contentPurpose, decodeEntry, encodeEntry } from "../src/guestbook";

// The exact bytes `ante-guestbook-contract`'s `delta_cbor_wire_format_is_pinned`
// pins on the Rust side. This test proves the web client's decode → encode
// round-trip lands on the same bytes, so a post from the browser is a delta the
// contract accepts. If the contract's `Entry` layout changes, both hexes move
// together or this fails.
const PINNED_DELTA_HEX =
  "a167656e747269657381a3646e616d6565616c69636564746578746568656c6c6f6570726f6f66a56b6964656e746974795f766b982018ea184a186c186318e2189c18520a18be18f51850187b13182e18c518f918951847187618ae18be18be187b18921842181e18ea186914184618d2182c67707572706f73657827616e74652d6775657374626f6f6b3a706f73743a76313a34333731306633666431373037343835656e6f6e63651970516274731b00000191dd9dec00697369676e617475726598401876188318e218b71887183918da182918a11848188a18c5183f18fe183b1852188b185e1854186f1873187218a51883183c0018ce1867189218410d18db18ed18bc186a031821187318c2182318b518c20718f3188518a818f9189d188a0b18c1184a18ca185a188c18c618a618b91840189318a918a718ef06";

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
    expect(entry.proof.purpose.startsWith("ante-guestbook:post:v1:")).toBe(true);
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
