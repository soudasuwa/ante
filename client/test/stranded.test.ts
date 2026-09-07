import { beforeEach, describe, expect, it, vi } from "vitest";

import { cborEncode } from "../src/cbor";
// Type-only: the value comes from the dynamic import below, which has to happen
// after vi.mock so the stubbed delegate-msg is the one ante.ts binds to.
import type { AnteClient as AnteClientType } from "../src/ante";

// findStrandedIdentities talks to arbitrary delegate generations through
// sendToDelegate. Stub it so each generation can be given its own answer.
const replies = new Map<string, unknown>();

vi.mock("../src/delegate-msg", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendToDelegate: async (_client: unknown, address: { keyBytes: number[] }) => {
    const key = address.keyBytes.map((b) => b.toString(16).padStart(2, "0")).join("");
    const answer = replies.get(key);
    if (answer === undefined) return { payloads: [], kinds: [] };
    return { payloads: [cborEncode(answer as never)], kinds: ["ApplicationMessage"] };
  },
  registerDelegate: async () => [],
}));

const { AnteClient } = await import("../src/ante");

const CURRENT = new Uint8Array(32).fill(1);
const STRANDED = new Uint8Array(32).fill(2);

const identity = (vk: Uint8Array) => ({ Identity: { verifying_key: Array.from(vk) } });
const gen = (n: number) => ({ key: `${n}`.repeat(64), codeHash: `${n}`.repeat(64) });

/// An AnteClient whose own identity is CURRENT, without touching a node.
function clientWithCurrentIdentity() {
  const c = Object.create(AnteClient.prototype) as AnteClientType;
  Object.assign(c, { client: {}, delegate: { keyBytes: [], codeHashBytes: [] } });
  vi.spyOn(c, "identity").mockResolvedValue(CURRENT);
  return c;
}

describe("findStrandedIdentities", () => {
  beforeEach(() => replies.clear());

  it("reports one row per IDENTITY, not per generation holding it", async () => {
    // Adopting an identity forward leaves it in the old generation AND the new
    // one, so after two re-keys the same key really is in several. Listing each
    // sighting gave the user a column of identical fingerprints and no way to
    // choose — while every choice led to the same identity.
    const a = gen(1), b = gen(2);
    replies.set(a.key, identity(STRANDED));
    replies.set(b.key, identity(STRANDED));

    const search = await clientWithCurrentIdentity().findStrandedIdentities([a, b]);
    expect(search.found).toHaveLength(1);
    expect(search.found[0].verifyingKey).toEqual(STRANDED);
    // Newest-first ordering, so the surviving row is the most recent holder.
    expect(search.found[0].delegate.key).toBe(a.key);
  });

  it("still lists genuinely different identities separately", async () => {
    const a = gen(1), b = gen(2);
    const other = new Uint8Array(32).fill(3);
    replies.set(a.key, identity(STRANDED));
    replies.set(b.key, identity(other));

    const search = await clientWithCurrentIdentity().findStrandedIdentities([a, b]);
    expect(search.found).toHaveLength(2);
  });

  it("never offers the identity this device already holds", async () => {
    const a = gen(1);
    replies.set(a.key, identity(CURRENT));

    const search = await clientWithCurrentIdentity().findStrandedIdentities([a]);
    expect(search.found).toHaveLength(0);
    expect(search.unresponsive).toHaveLength(0);
  });

  it("separates a definite NoIdentity from silence", async () => {
    const answered = gen(1), silent = gen(2);
    replies.set(answered.key, "NoIdentity");
    // silent has no entry: sendToDelegate returns no payloads.

    const search = await clientWithCurrentIdentity().findStrandedIdentities([answered, silent]);
    expect(search.found).toHaveLength(0);
    // The one that answered "nothing here" is NOT unresponsive — that
    // distinction is what lets the UI say the search actually concluded.
    expect(search.unresponsive).toEqual([silent]);
  });
});
