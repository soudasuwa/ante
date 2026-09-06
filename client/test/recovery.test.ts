import { describe, expect, it } from "vitest";

import { fingerprint } from "../src/ante-proof";
import {
  identityCodeFromSeed,
  identityFingerprintFromCode,
  identitySeedFromCode,
} from "../src/recovery";
import { bytesToHex, hexToBytes } from "../src/util";

// Seed / verifying key from ante-core's pinned test vector (testvec::SEED).
const SEED_HEX = "2a".repeat(32);
const VK_HEX = "197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61";

describe("identity recovery code", () => {
  const seed = hexToBytes(SEED_HEX);
  const code = identityCodeFromSeed(seed);

  it("starts with ante- and round-trips to the same seed", () => {
    expect(code.startsWith("ante-")).toBe(true);
    expect(bytesToHex(identitySeedFromCode(code))).toBe(SEED_HEX);
  });

  it("tolerates surrounding whitespace", () => {
    expect(bytesToHex(identitySeedFromCode(`  ${code}\n`))).toBe(SEED_HEX);
  });

  it("resolves to the right identity fingerprint without importing", () => {
    expect(identityFingerprintFromCode(code)).toBe(fingerprint(hexToBytes(VK_HEX)));
  });

  it("rejects a one-character typo (checksum)", () => {
    const i = code.length - 3;
    const swapped = code[i] === "A" ? "B" : "A";
    const typo = code.slice(0, i) + swapped + code.slice(i + 1);
    expect(() => identitySeedFromCode(typo)).toThrow(/checksum|base58|length/);
  });

  it("rejects a missing prefix", () => {
    expect(() => identitySeedFromCode(code.slice(5))).toThrow(/ante-/);
  });

  it("rejects a truncated code", () => {
    expect(() => identitySeedFromCode(code.slice(0, code.length - 6))).toThrow();
  });

  it("refuses a seed that is not 32 bytes", () => {
    expect(() => identityCodeFromSeed(new Uint8Array(31))).toThrow(/32 bytes/);
  });
});
