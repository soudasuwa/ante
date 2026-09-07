import { describe, expect, it, vi } from "vitest";

import { anteProofToCborValue, decodeAnteProof, type AnteProof } from "../src/ante-proof";
import { cborEncode } from "../src/cbor";
import { migrateRegistry } from "../src/migrate";
import { hexToBytes } from "../src/util";

// The pinned vector's proof: 16 bits for "ante:identity-level:v1".
const PROOF_HEX =
  "a56b6964656e746974795f766b98201819187f186b182318e1186c1885183218c618ab18c8183818fa18cd185e18a7188918be0c187618b2189203183403189b18fa188b183d1836188d186167707572706f736576616e74653a6964656e746974792d6c6576656c3a7631656e6f6e6365198b196274731b00000191dd9dec00697369676e6174757265984018f6188b07189c18d5182b184518e8187f185e187118a418e618cc189e18ff1897185f189e1838188018ef186d1860188f18c50f18de18e618f118de186e189d186518510f1834182f189a1869189e0d18d0185a18cc189a188418ad14184b187e184a18bc186e1858121872189718ea18ad182718e418970a";

const proof: AnteProof = decodeAnteProof(hexToBytes(PROOF_HEX));

/// A registry state holding that one proof, keyed by its own vk.
function stateWith(p: AnteProof): Uint8Array {
  const levels = new Map<unknown, unknown>();
  levels.set(Array.from(p.identityVk), anteProofToCborValue(p));
  return cborEncode({ levels } as never);
}

/// A FreenetClient stub: each predecessor id maps to bytes, "absent", or a hang.
function client(responses: Record<string, Uint8Array | "absent" | "hang">) {
  return {
    getContractState: (key: { bytes(): number[] } | unknown) => {
      const id = (key as { __id: string }).__id;
      const r = responses[id];
      if (r === "hang") return new Promise<Uint8Array>(() => {}); // never settles
      if (r === "absent") return Promise.reject(new Error("contract not found"));
      return Promise.resolve(r);
    },
  } as never;
}

// contractKeyFromId is called inside migrateRegistry; stub it to carry the id.
vi.mock("../src/freenet", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  contractKeyFromId: (id: string) => ({ __id: id }),
}));

describe("registry carry-forward probe", () => {
  it("carries proofs from a predecessor that answers", async () => {
    const submitted: AnteProof[][] = [];
    const report = await migrateRegistry(
      client({ old1: stateWith(proof) }),
      "current",
      ["old1"],
      12,
      async (p) => void submitted.push(p),
    );
    expect(report.hits).toEqual(["old1"]);
    expect(report.carried).toBe(1);
    expect(report.complete).toBe(true);
    expect(submitted[0][0].identityVk).toEqual(proof.identityVk);
  });

  // The distinction that a UI got wrong: `carried` counts everyone's records,
  // so a brand-new user was told 5 levels had been "recovered" while their own
  // level still read unproven. Only carriedSelf is about the person looking.
  it("reports carriedSelf false when the sweep only moved other identities", async () => {
    const stranger = new Uint8Array(32).fill(9);
    const report = await migrateRegistry(
      client({ old1: stateWith(proof) }),
      "current",
      ["old1"],
      12,
      async () => {},
      stranger,
    );
    expect(report.carried).toBe(1);
    expect(report.carriedSelf).toBe(false);
  });

  it("reports carriedSelf true when one of the carried proofs is ours", async () => {
    const report = await migrateRegistry(
      client({ old1: stateWith(proof) }),
      "current",
      ["old1"],
      12,
      async () => {},
      proof.identityVk,
    );
    expect(report.carriedSelf).toBe(true);
  });

  it("reports carriedSelf false when no identity is held on this device", async () => {
    const report = await migrateRegistry(
      client({ old1: stateWith(proof) }),
      "current",
      ["old1"],
      12,
      async () => {},
    );
    expect(report.carried).toBe(1);
    expect(report.carriedSelf).toBe(false);
  });

  it("treats a timeout as unresolved, NOT as empty", async () => {
    const report = await migrateRegistry(
      client({ slow: "hang" }),
      "current",
      ["slow"],
      12,
      async () => {},
    );
    expect(report.unresolved).toEqual(["slow"]);
    expect(report.empty).toEqual([]);
    // The whole point: a slow predecessor must not close the migration.
    expect(report.complete).toBe(false);
  }, 20_000);

  it("treats NotFound as unresolved too — it is not proof of absence", async () => {
    const report = await migrateRegistry(
      client({ gone: "absent" }),
      "current",
      ["gone"],
      12,
      async () => {},
    );
    expect(report.unresolved).toEqual(["gone"]);
    expect(report.complete).toBe(false);
  });

  it("sweeps every generation rather than stopping at the first hit", async () => {
    const seen: AnteProof[][] = [];
    const report = await migrateRegistry(
      client({ a: stateWith(proof), b: new Uint8Array(), c: stateWith(proof) }),
      "current",
      ["a", "b", "c"],
      12,
      async (p) => void seen.push(p),
    );
    expect(report.hits).toEqual(["a", "c"]);
    expect(report.empty).toEqual(["b"]);
    expect(seen[0]).toHaveLength(2); // both, in one delta
  });

  it("drops proofs below the current floor rather than poisoning the delta", async () => {
    // The contract rejects a whole delta if any proof is inadmissible, so an
    // unusable one must not travel with the rest.
    const report = await migrateRegistry(
      client({ old1: stateWith(proof) }),
      "current",
      ["old1"],
      24, // the pinned proof is 16 bits
      async () => {},
    );
    expect(report.carried).toBe(0);
    expect(report.empty).toEqual(["old1"]);
  });

  it("skips the current generation and submits nothing when there is nothing", async () => {
    const submit = vi.fn();
    const report = await migrateRegistry(
      client({}),
      "current",
      ["current"],
      12,
      submit,
    );
    expect(submit).not.toHaveBeenCalled();
    expect(report.complete).toBe(true);
  });
});
