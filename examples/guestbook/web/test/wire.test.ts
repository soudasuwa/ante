import { describe, expect, it } from "vitest";

import { bytesToHex, cborDecode, cborEncode, hexToBytes, mapGet } from "@ante/client";

import { decodeEntry, encodeEntry } from "../src/guestbook";

// The exact bytes `ante-guestbook-contract`'s `delta_cbor_wire_format_is_pinned`
// pins on the Rust side. This test proves the web client's decode → encode
// round-trip lands on the same bytes, so a post from the browser is a delta the
// contract accepts. If the contract's `Entry` layout changes, both hexes move
// together or this fails.
const PINNED_DELTA_HEX =
  "a167656e747269657381a3646e616d6565616c69636564746578746568656c6c6f6570726f6f66a56b6964656e746974795f766b982018ea184a186c186318e2189c18520a18be18f51850187b13182e18c518f918951847187618ae18be18be187b18921842181e18ea186914184618d2182c67707572706f736576616e74652d6775657374626f6f6b3a706f73743a7631656e6f6e6365192c396274731b00000191dd9dec00697369676e61747572659840184c1832182e1887185a1861187218b318a3189218a0181c18eb1869182e18ec18821863184718350418221718e5186f1839189c187618571822185d189618ec18561318fc183d184c18a4183d18d018ac18df18f418791866183418fc18d118e918e118c7186c1842184518211851186502182a1401186102";

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
    expect(entry.proof.purpose).toBe("ante-guestbook:post:v1");
    expect(entry.proof.identityVk).toHaveLength(32);
    expect(entry.proof.signature).toHaveLength(64);
  });
});
