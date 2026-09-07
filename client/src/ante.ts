// The ante integration. This is the whole ante-specific surface a producer app
// touches: attach the delegate, then `commit(purpose)` — challenge, grind, and
// the consent prompt are handled inside.
//
// The wire protocol is pinned in `ante_core::protocol`.

import { decodeAnteProof, type AnteProof } from "./ante-proof";
import { asBytes, asString, cborDecode, cborEncode, CborValue, enumVariant, mapGet } from "./cbor";
import {
  ANTE_DELEGATE_CODE_HASH_BYTES,
  ANTE_DELEGATE_KEY_BYTES,
  ANTE_DELEGATE_WASM_B64,
  delegateEmbedded,
} from "./embedded";
import {
  base64ToBytes,
  registerDelegate,
  describeEmptyReply,
  sendToDelegate,
  type DelegateAddress,
} from "./delegate-msg";
import type { FreenetClient } from "./freenet";
import { powBits, type Solution } from "./pow";
import { bytesEqual, hexToBytes } from "./util";
import PowWorker from "./pow-worker?worker&inline";
import type { PowWorkerMessage, PowWorkerRequest } from "./pow-worker";

/// The node holds a prompting request (`Commit`, `ExportIdentity`,
/// `ImportIdentity`) open while the consent prompt is on screen — up to exactly
/// 60 s (`USER_INPUT_TIMEOUT` in freenet-core), then auto-denies. Wait past that.
const PROMPT_TIMEOUT_MS = 75_000;

export type CommitOutcome =
  | { kind: "committed"; proof: AnteProof; bytes: Uint8Array }
  | { kind: "denied" };

export type ExportOutcome = { kind: "exported"; seed: Uint8Array } | { kind: "denied" };

export type ImportOutcome =
  | { kind: "imported"; verifyingKey: Uint8Array }
  | { kind: "denied" };

/// Options for a request that raises a consent prompt on the node.
export interface PromptOptions {
  /// Called just before the request goes to the node; the prompt appears there
  /// a moment later. There is no signal for the prompt itself.
  onPrompt?: () => void;
}

export interface CommitOptions extends PromptOptions {
  /// Minimum leading-zero bits to grind for. Default 18.
  minBits?: number;
  /// Called with (hashesTried, hashesPerSecond) during the grind.
  onProgress?: (tried: number, hps: number) => void;
}

/// Live state of an open-ended grind.
export interface GrindProgress {
  /// Best solution so far, or null until the first one turns up.
  best: Solution | null;
  tried: number;
  hashesPerSecond: number;
  /// Seconds since the grind started.
  elapsed: number;
}

export interface GrindOptions {
  /// The floor the finished proof must clear — your consumer's policy.
  /// `commit()` refuses below it. Default 18.
  minBits?: number;
  /// Called on every improvement, and periodically in between.
  onProgress?: (progress: GrindProgress) => void;
  /// Fired just before the authorization prompt appears on the node, so the UI
  /// can say what is about to happen. The prompt now precedes the work, so this
  /// fires first rather than after the grind.
  onPrompt?: () => void;
}

/// An open-ended grind the caller stops when satisfied — for apps where the
/// user chooses how much to invest rather than being handed a fixed bar.
/// Started by [`AnteClient.grind`].
export interface GrindSession {
  /// Best solution so far, or null.
  readonly best: Solution | null;
  /// Whether [`commit`] would be accepted — i.e. `best` clears `minBits`.
  readonly ready: boolean;
  /// Stop grinding and sign the best solution found, raising the consent
  /// prompt. Throws if nothing has cleared `minBits` yet.
  commit(opts?: PromptOptions): Promise<CommitOutcome>;
  /// Abandon the grind without committing. Safe to call twice.
  stop(): void;
}

/// A delegate generation this one replaced. Addressing it needs no WASM:
/// freenet-core retains delegate code indefinitely (only an explicit
/// `UnregisterDelegate` removes it), so a generation the node once registered
/// is still reachable by its key.
export interface PreviousDelegate {
  /// blake3(code_hash) — hex.
  key: string;
  /// blake3(wasm) — hex.
  codeHash: string;
}

export interface StrandedIdentity {
  delegate: PreviousDelegate;
  /// The identity that generation still holds.
  verifyingKey: Uint8Array;
}

export interface StrandedSearch {
  /// Generations holding an identity that is not the current one.
  found: StrandedIdentity[];
  /// Generations that did not answer. A delegate this node never registered is
  /// indistinguishable from a broken one — both look like silence, and neither
  /// is evidence that nothing is there. Surface it; do not treat it as empty.
  unresponsive: PreviousDelegate[];
}

/// Thrown when the user refuses to authorize a grind before it starts.
///
/// A distinct type because refusal is not a failure: nothing went wrong, the
/// person said no, and an app should say so plainly rather than render it as an
/// error. `grind()` throws it because a GrindSession has nothing meaningful to
/// return; `commit()` returns `{ denied: true }` instead, matching how it
/// already reports a refusal at signing time.
export class GrindDeniedError extends Error {
  constructor() {
    super("you declined to spend the work");
    this.name = "GrindDeniedError";
  }
}

export class AnteClient {
  private constructor(
    private readonly client: FreenetClient,
    private readonly delegate: DelegateAddress,
  ) {}

  /// Register the ante delegate on the node and return a client. The delegate
  /// WASM is embedded in this package — nothing to host or configure.
  static async attach(client: FreenetClient): Promise<AnteClient> {
    if (!delegateEmbedded()) {
      throw new Error("ante delegate not embedded — run scripts/sync-delegate.sh in the ante repo");
    }
    const address: DelegateAddress = {
      keyBytes: ANTE_DELEGATE_KEY_BYTES,
      codeHashBytes: ANTE_DELEGATE_CODE_HASH_BYTES,
    };
    await registerDelegate(client, address, base64ToBytes(ANTE_DELEGATE_WASM_B64));
    return new AnteClient(client, address);
  }

  /// The user's identity verifying key (32 bytes), created on first call. No
  /// prompt.
  async identity(): Promise<Uint8Array> {
    const reply = await this.oneShot("GetIdentity");
    expect(reply.variant, "Identity");
    return asBytes(mapGet(reply.fields!, "verifying_key"));
  }

  /// Grind proof of work against `purpose` and, with the user's consent, get
  /// back a signed proof. `outcome.bytes` is the CBOR to attach to a contract
  /// write; `outcome.proof` is the decoded form.
  async commit(purpose: string, opts: CommitOptions = {}): Promise<CommitOutcome> {
    const minBits = opts.minBits ?? 18;
    // Consent first: a refusal here costs nothing, where a refusal after the
    // grind costs the user everything they just spent.
    const authorized = await this.requestGrind(purpose, minBits, { onPrompt: opts.onPrompt });
    if (authorized.denied) return { kind: "denied" };
    const nonce = await grindInWorker(authorized.challenge, minBits, opts.onProgress);
    // Not prompted again: the delegate consumes the authorization it parked.
    return this.signCommit(purpose, nonce, minBits);
  }

  /// Look for an identity stranded in an earlier delegate generation.
  ///
  /// A delegate's key is `blake3(blake3(wasm))`, and the identity seed lives in
  /// a secret namespace keyed by it — so changing the delegate leaves the old
  /// identity intact but unreachable from the new one. This finds it.
  ///
  /// Costs no prompt, and — since `HasIdentity` — no write either, which is
  /// what makes it safe to run automatically on load.
  ///
  /// Results are deduplicated by identity: several generations can hold the
  /// same key once it has been adopted forward, and the user is choosing an
  /// identity, not a generation.
  async findStrandedIdentities(previous: readonly PreviousDelegate[]): Promise<StrandedSearch> {
    const current = await this.identity();
    const search: StrandedSearch = { found: [], unresponsive: [] };

    for (const gen of previous) {
      const address: DelegateAddress = {
        keyBytes: Array.from(hexToBytes(gen.key)),
        codeHashBytes: Array.from(hexToBytes(gen.codeHash)),
      };
      try {
        // HasIdentity first, because it is a pure read. GetIdentity creates on
        // miss, so probing with it mints an identity inside the generation
        // being probed and then reports that fresh key as a stranded identity —
        // the search fabricating its own result. Only fall back to GetIdentity
        // for generations published before HasIdentity existed, which reject it
        // as malformed; their WASM cannot be changed, so create-on-probe is
        // unavoidable there and is confined to them.
        let parsed = await this.probe(address, "HasIdentity");
        if (parsed?.variant === "Error") parsed = await this.probe(address, "GetIdentity");

        if (!parsed) {
          search.unresponsive.push(gen);
          continue;
        }
        // A definite "nothing here" — not silence. Neither found nor
        // unresponsive, so the UI can say the search actually concluded.
        if (parsed.variant === "NoIdentity") continue;
        if (parsed.variant !== "Identity") {
          search.unresponsive.push(gen);
          continue;
        }
        const vk = asBytes(mapGet(parsed.fields!, "verifying_key"));
        if (bytesEqual(vk, current)) continue;
        // One identity, not one row per generation that happens to hold it.
        // Adopting an identity forward leaves it in BOTH the old generation and
        // the one it moved into, so after two re-keys the same key is genuinely
        // present in several — and the user was offered a list of identical
        // fingerprints with no way to choose between them, when every choice
        // led to the same place. `previous` is newest-first, so the first
        // sighting is the most recent generation holding it.
        if (search.found.some((f) => bytesEqual(f.verifyingKey, vk))) continue;
        search.found.push({ delegate: gen, verifyingKey: vk });
      } catch {
        search.unresponsive.push(gen);
      }
    }
    return search;
  }

  /// Move an identity from an earlier generation into this one.
  ///
  /// Two prompts, and both are correct: the old generation must agree to reveal
  /// its seed, and the current one must agree to replace what it holds. Neither
  /// can be skipped — a delegate that handed its secrets to another on request
  /// would be a hole, not a feature.
  async adoptStrandedIdentity(
    from: PreviousDelegate,
    opts: PromptOptions = {},
  ): Promise<ImportOutcome> {
    const address: DelegateAddress = {
      keyBytes: Array.from(hexToBytes(from.key)),
      codeHashBytes: Array.from(hexToBytes(from.codeHash)),
    };
    opts.onPrompt?.();
    const reply = await sendToDelegate(
      this.client,
      address,
      cborEncode("ExportIdentity"),
      PROMPT_TIMEOUT_MS,
    );
    if (reply.payloads.length === 0) throw new Error("the earlier version did not answer");
    const parsed = enumVariant(cborDecode(reply.payloads[0]));
    if (parsed.variant === "Denied") return { kind: "denied" };
    if (parsed.variant === "Error") {
      throw new Error(`earlier version: ${asString(mapGet(parsed.fields!, "message"))}`);
    }
    expect(parsed.variant, "IdentitySeed");
    const seed = asBytes(mapGet(parsed.fields!, "seed"));
    return this.importIdentity(seed, opts);
  }

  /// Start an open-ended grind and hand back a handle. Unlike `commit`, which
  /// grinds to a fixed bar and signs, this keeps improving until you call
  /// `commit()` or `stop()` — so a UI can show the work climbing and let the
  /// user decide when it is enough.
  ///
  ///   const session = await ante.grind("myapp:post:v1", {
  ///     minBits: 16,
  ///     onProgress: (p) => render(p.best?.bits ?? 0, p.elapsed),
  ///   });
  ///   // …later, when the user clicks post:
  ///   const outcome = await session.commit();
  async grind(purpose: string, opts: GrindOptions = {}): Promise<GrindSession> {
    const minBits = opts.minBits ?? 18;
    // Ask before spending, not after. An open-ended grind can run for minutes;
    // discovering at the end that it was unwanted is the worst possible moment.
    const authorized = await this.requestGrind(purpose, minBits, { onPrompt: opts.onPrompt });
    if (authorized.denied) throw new GrindDeniedError();
    const challenge = authorized.challenge;
    const worker = new PowWorker();
    const started = performance.now();

    let best: Solution | null = null;
    let stopped = false;
    const halt = () => {
      if (!stopped) {
        stopped = true;
        worker.terminate();
      }
    };

    worker.onmessage = (event: MessageEvent<PowWorkerMessage>) => {
      const msg = event.data;
      if (msg.type === "best") {
        // Never trust the worker's own bit count. Re-derive it here from the
        // same challenge, with the same function the verifier uses, so the
        // number shown to a user is the number a contract will grade. A worker
        // that overstated would otherwise mint a proof the delegate silently
        // grades lower — the UI would promise 25 bits and the entry would land
        // in a lower tier with no error anywhere.
        const bits = powBits(challenge, msg.nonce);
        if (bits > (best?.bits ?? -1)) best = { nonce: msg.nonce, bits };
      }
      const elapsed = (performance.now() - started) / 1000;
      opts.onProgress?.({
        best,
        tried: msg.tried,
        hashesPerSecond: elapsed > 0 ? msg.tried / elapsed : 0,
        elapsed,
      });
    };
    worker.postMessage({ challenge } satisfies PowWorkerRequest);

    const client = this;
    return {
      get best() {
        return best;
      },
      get ready() {
        return best !== null && best.bits >= minBits;
      },
      stop: halt,
      async commit(promptOpts: PromptOptions = {}) {
        const solution = best;
        if (solution === null || solution.bits < minBits) {
          throw new Error(
            `grind has not reached ${minBits} bits yet (best ${solution?.bits ?? 0})`,
          );
        }
        halt();
        // The authorization parked by requestGrind covers this, so no second
        // prompt. onPrompt stays honoured for the fallback path, where the
        // delegate has no authorization and asks after all.
        return client.signCommit(purpose, solution.nonce, minBits, promptOpts.onPrompt);
      },
    };
  }

  /// The challenge preimage for `purpose` — for callers running their own
  /// grinder. Grind `blake3(bytes ‖ nonce_le)`, count leading zero bits.
  /// Ask the user to authorize grinding BEFORE any of it happens.
  ///
  /// Returns the challenge on approval — so this replaces `challenge()` rather
  /// than adding a round trip — or `{ denied: true }` if refused, in which case
  /// nothing has been spent.
  ///
  /// Prefer this over `challenge()`. The old order asked for consent after the
  /// grind, which meant a refusal cost the user the work they had just done,
  /// and put the only decision they make after the only expensive part. An app
  /// the user has chosen "always allow" for is not prompted at all.
  ///
  /// The delegate parks a single-use authorization scoped to this exact caller,
  /// purpose and bar, so the `signCommit` that follows does not ask again.
  async requestGrind(
    purpose: string,
    minBits: number,
    opts: PromptOptions = {},
  ): Promise<{ denied: true } | { denied: false; challenge: Uint8Array }> {
    const outcome = await this.prompted(
      { RequestGrind: { purpose, min_bits: minBits } },
      opts.onPrompt,
    );
    if (outcome.denied) return { denied: true };
    expect(outcome.variant, "GrindAuthorized");
    return { denied: false, challenge: asBytes(mapGet(outcome.fields!, "bytes")) };
  }

  async challenge(purpose: string): Promise<Uint8Array> {
    const reply = await this.oneShot({ Challenge: { purpose } });
    expect(reply.variant, "Challenge");
    return asBytes(mapGet(reply.fields!, "bytes"));
  }

  /// Low-level: sign a proof over a nonce you already ground.
  async signCommit(
    purpose: string,
    nonce: number,
    minBits: number,
    onPrompt?: () => void,
  ): Promise<CommitOutcome> {
    const reply = await this.prompted(
      { Commit: { purpose, nonce, min_bits: minBits, ts: Date.now() } },
      onPrompt,
    );
    if (reply.denied) return { kind: "denied" };
    expect(reply.variant, "Committed");
    const bytes = asBytes(mapGet(reply.fields!, "proof"));
    return { kind: "committed", proof: decodeAnteProof(bytes), bytes };
  }

  /// Reveal the identity's 32-byte secret seed, for the user to back up.
  /// Raises a consent prompt — `outcome.kind === "denied"` if the user
  /// cancels. Pass `outcome.seed` to `identityCodeFromSeed` for a recovery
  /// code, or store the bytes directly. Handle the result carefully: it is the
  /// private key.
  async exportIdentity(opts: PromptOptions = {}): Promise<ExportOutcome> {
    const reply = await this.prompted("ExportIdentity", opts.onPrompt);
    if (reply.denied) return { kind: "denied" };
    expect(reply.variant, "IdentitySeed");
    return { kind: "exported", seed: asBytes(mapGet(reply.fields!, "seed")) };
  }

  /// Set this device's identity to `seed` (32 bytes) — restoring a backup.
  /// Raises a consent prompt; if an identity already exists the prompt warns it
  /// will be replaced. Re-importing the current seed resolves without a prompt.
  async importIdentity(seed: Uint8Array, opts: PromptOptions = {}): Promise<ImportOutcome> {
    if (seed.length !== 32) throw new Error("identity seed must be 32 bytes");
    const reply = await this.prompted({ ImportIdentity: { seed: Array.from(seed) } }, opts.onPrompt);
    if (reply.denied) return { kind: "denied" };
    expect(reply.variant, "Imported");
    return { kind: "imported", verifyingKey: asBytes(mapGet(reply.fields!, "verifying_key")) };
  }

  /// Origins that hold an "always allow" grant. For a managing UI.
  async listGrants(): Promise<Uint8Array[]> {
    const reply = await this.oneShot("ListGrants");
    expect(reply.variant, "Grants");
    const origins = mapGet(reply.fields!, "origins");
    return Array.isArray(origins) ? origins.map((o) => asBytes(o)) : [];
  }

  /// Remove one "always allow" grant, or all when `origin` is null.
  async revokeGrant(origin: Uint8Array | null): Promise<void> {
    const req: CborValue = { RevokeGrant: { origin: origin ? Array.from(origin) : null } };
    const reply = await this.oneShot(req);
    expect(reply.variant, "Revoked");
  }

  /// Send one request to an arbitrary delegate generation and decode its
  /// answer, or null if it said nothing. Never throws for a delegate-level
  /// error: an `Error` reply is a real answer here (it is how an older
  /// generation rejects a request it does not know), and the caller decides.
  private async probe(
    address: DelegateAddress,
    request: CborValue,
  ): Promise<{ variant: string; fields: CborValue | null } | null> {
    const reply = await sendToDelegate(this.client, address, cborEncode(request));
    if (reply.payloads.length === 0) return null;
    return enumVariant(cborDecode(reply.payloads[0]));
  }

  private async oneShot(request: CborValue): Promise<{ variant: string; fields: CborValue | null }> {
    const reply = await sendToDelegate(this.client, this.delegate, cborEncode(request));
    if (reply.payloads.length === 0) {
      throw new Error(`ante delegate returned no response — ${describeEmptyReply(reply)}`);
    }
    const parsed = enumVariant(cborDecode(reply.payloads[0]));
    if (parsed.variant === "Error") {
      throw new Error(`ante delegate: ${asString(mapGet(parsed.fields!, "message"))}`);
    }
    return parsed;
  }

  /// A request that raises a consent prompt: fire `onPrompt`, send with the
  /// long timeout, and fold `Denied` / `Error` into a single shape.
  private async prompted(
    request: CborValue,
    onPrompt: (() => void) | undefined,
  ): Promise<
    { denied: true } | { denied: false; variant: string; fields: CborValue | null }
  > {
    onPrompt?.();
    const reply = await sendToDelegate(
      this.client,
      this.delegate,
      cborEncode(request),
      PROMPT_TIMEOUT_MS,
    );
    if (reply.payloads.length === 0) {
      throw new Error(`no response from the delegate — ${describeEmptyReply(reply)}`);
    }
    const parsed = enumVariant(cborDecode(reply.payloads[0]));
    if (parsed.variant === "Denied") return { denied: true };
    if (parsed.variant === "Error") {
      throw new Error(`ante delegate: ${asString(mapGet(parsed.fields!, "message"))}`);
    }
    return { denied: false, variant: parsed.variant, fields: parsed.fields };
  }
}

function grindInWorker(
  challenge: Uint8Array,
  targetBits: number,
  onProgress?: (tried: number, hps: number) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new PowWorker();
    const started = performance.now();
    worker.onmessage = (event: MessageEvent<PowWorkerMessage>) => {
      const msg = event.data;
      const elapsed = (performance.now() - started) / 1000;
      onProgress?.(msg.tried, elapsed > 0 ? msg.tried / elapsed : 0);
      if (msg.type === "done") {
        worker.terminate();
        resolve(msg.nonce);
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "grind worker failed"));
    };
    worker.postMessage({ challenge, targetBits } satisfies PowWorkerRequest);
  });
}

function expect(got: string, want: string): void {
  if (got !== want) throw new Error(`expected ${want} response, got ${got}`);
}
