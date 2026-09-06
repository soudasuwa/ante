// The identity-management UI. Vanilla TS; one module.

import "./style.css";

import { AnteClient, type CommitOutcome } from "./ante-client";
import {
  decodeAnteProof,
  fingerprint,
  IDENTITY_LEVEL_PURPOSE,
  verifyAnteProof,
} from "./ante-proof";
import { base64ToBytes, registerDelegate, type DelegateAddress } from "./delegate-api";
import {
  ANTE_DELEGATE_CODE_HASH_BYTES,
  ANTE_DELEGATE_KEY_BYTES,
  ANTE_DELEGATE_WASM_B64,
  delegateIsBuilt,
} from "./delegate-wasm";
import { FreenetClient } from "./freenet";
import type { PowWorkerMessage, PowWorkerRequest } from "./pow-worker";
import { RegistryClient, registryConfigured } from "./registry";
import {
  forgetHeldProof,
  loadHeldProofs,
  proofCborFromHex,
  proofCborToHex,
  saveHeldProof,
  type HeldProof,
} from "./store";
import { bytesToHex } from "./util";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let ante: AnteClient | null = null;
let registry: RegistryClient | null = null;
let identityVk: Uint8Array | null = null;

// --------------------------------------------------------------------------
// boot
// --------------------------------------------------------------------------

function setConn(text: string, state: "ok" | "warn" | "err" | "") {
  const el = $("conn");
  el.textContent = text;
  el.className = `status ${state}`;
}

async function boot() {
  wireStaticHandlers();
  renderHeld();

  if (!delegateIsBuilt()) {
    setConn(
      "the ante delegate is not built — run ./scripts/sync-delegate.sh, then reload",
      "err",
    );
    return;
  }

  const address: DelegateAddress = {
    keyBytes: ANTE_DELEGATE_KEY_BYTES,
    codeHashBytes: ANTE_DELEGATE_CODE_HASH_BYTES,
  };

  let markOpen: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    markOpen = resolve;
  });
  const client = new FreenetClient({
    onOpen: () => {
      setConn("connected — registering the delegate…", "ok");
      markOpen();
    },
    onClose: (code, reason) => setConn(`connection closed: ${reason || code}`, "err"),
  });

  try {
    await Promise.race([
      opened,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("node did not accept the connection")), 8000),
      ),
    ]);
    await registerDelegate(client, address, base64ToBytes(ANTE_DELEGATE_WASM_B64));
    ante = new AnteClient(client, address);
    if (registryConfigured()) registry = new RegistryClient(client);
    identityVk = await ante.getIdentity();
    renderIdentity();
    for (const id of ["identity-panel", "strengthen-panel", "action-panel", "held-panel"]) {
      $(id).hidden = false;
    }
    setConn(registry ? "ready" : "ready — registry not configured, local level only", "ok");
    void refreshRegistryLevel();
  } catch (err) {
    setConn(`could not reach the delegate: ${(err as Error).message}`, "err");
  }
}

// --------------------------------------------------------------------------
// identity
// --------------------------------------------------------------------------

function renderIdentity() {
  if (!identityVk) return;
  $("id-fingerprint").textContent = fingerprint(identityVk);
  $("id-vk").textContent = bytesToHex(identityVk);
  renderLevel();
}

function renderLevel() {
  const best = loadHeldProofs()
    .filter((p) => p.purpose === IDENTITY_LEVEL_PURPOSE)
    .reduce((max, p) => Math.max(max, p.bits), 0);
  $("id-level").textContent = best > 0 ? `${best} bits` : "none yet";
}

async function refreshRegistryLevel() {
  const el = $("id-registry-level");
  if (!registry || !identityVk) {
    el.textContent = registryConfigured() ? "—" : "not configured";
    return;
  }
  el.textContent = "checking…";
  try {
    const bits = await registry.readLevel(identityVk);
    el.textContent = bits === null ? "not published" : `${bits} bits`;
  } catch (err) {
    el.textContent = `lookup failed: ${(err as Error).message}`;
  }
}

// --------------------------------------------------------------------------
// grind + commit
// --------------------------------------------------------------------------

function grindInWorker(
  challenge: Uint8Array,
  targetBits: number,
  onProgress: (tried: number, hps: number) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./pow-worker.ts", import.meta.url), { type: "module" });
    const started = performance.now();
    worker.onmessage = (event: MessageEvent<PowWorkerMessage>) => {
      const msg = event.data;
      const elapsed = (performance.now() - started) / 1000;
      if (msg.type === "progress") {
        onProgress(msg.tried, elapsed > 0 ? msg.tried / elapsed : 0);
      } else {
        onProgress(msg.tried, elapsed > 0 ? msg.tried / elapsed : 0);
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

async function grindAndCommit(
  purpose: string,
  targetBits: number,
  progressEl: HTMLElement,
): Promise<CommitOutcome> {
  if (!ante) throw new Error("not connected");
  progressEl.hidden = false;
  progressEl.textContent = "asking the delegate for the challenge…";

  const challenge = await ante.challenge(purpose);

  const nonce = await grindInWorker(challenge, targetBits, (tried, hps) => {
    progressEl.textContent = `grinding — ${tried.toLocaleString()} hashes (${Math.round(
      hps,
    ).toLocaleString()}/s)`;
  });

  progressEl.textContent = "grind done — approve the prompt on your node to sign";
  const outcome = await ante.commit(purpose, nonce, targetBits, () => {
    progressEl.textContent = "waiting for you to approve the consent prompt…";
  });
  return outcome;
}

async function runGrindPanel(opts: {
  purpose: string;
  targetBits: number;
  progressId: string;
  buttonId: string;
}) {
  const btn = $(opts.buttonId) as HTMLButtonElement;
  const progress = $(opts.progressId);
  btn.disabled = true;
  try {
    const outcome = await grindAndCommit(opts.purpose, opts.targetBits, progress);
    if (outcome.kind === "denied") {
      progress.textContent = "you declined the prompt — nothing was signed";
      return;
    }
    const bits = verifyAnteProof(outcome.proof, 0);
    const held: HeldProof = {
      purpose: opts.purpose,
      bits: bits.ok ? bits.bits : opts.targetBits,
      ts: outcome.proof.ts,
      proofCborHex: proofCborToHex(outcome.proofCbor),
    };
    saveHeldProof(held);
    renderHeld();
    renderLevel();
    progress.textContent = `signed — ${held.bits} bits for ${opts.purpose}`;

    // An identity-level proof also goes to the registry, if one is configured.
    if (opts.purpose === IDENTITY_LEVEL_PURPOSE && registry) {
      progress.textContent = `signed ${held.bits} bits — publishing to the registry…`;
      try {
        await registry.publishProof(outcome.proofCbor);
        await refreshRegistryLevel();
        progress.textContent = `published — ${held.bits} bits on the registry`;
      } catch (err) {
        progress.textContent = `signed ${held.bits} bits, but the registry publish failed: ${
          (err as Error).message
        }`;
      }
    }
  } catch (err) {
    progress.textContent = `failed: ${(err as Error).message}`;
  } finally {
    btn.disabled = false;
  }
}

// --------------------------------------------------------------------------
// held proofs
// --------------------------------------------------------------------------

function renderHeld() {
  const list = $("held-list");
  const held = loadHeldProofs();
  list.innerHTML = "";
  if (held.length === 0) {
    list.innerHTML = `<li class="muted">none yet</li>`;
    return;
  }
  for (const p of held) {
    const li = document.createElement("li");
    const when = new Date(p.ts).toISOString().replace("T", " ").slice(0, 16);
    li.innerHTML = `
      <div class="held-head"><strong>${escapeHtml(p.purpose)}</strong><span>${p.bits} bits · ${when}</span></div>
      <code class="held-cbor">${p.proofCborHex.slice(0, 48)}…</code>
      <div class="held-actions">
        <button data-act="copy">copy</button>
        <button data-act="check">check</button>
        <button data-act="forget" class="ghost">forget</button>
      </div>`;
    li.querySelector('[data-act="copy"]')!.addEventListener("click", () => {
      void navigator.clipboard?.writeText(p.proofCborHex);
    });
    li.querySelector('[data-act="check"]')!.addEventListener("click", () => {
      ($("verify-input") as HTMLTextAreaElement).value = p.proofCborHex;
      ($("verify-bits") as HTMLInputElement).value = String(p.bits);
      runVerify();
      $("verify-panel").scrollIntoView({ behavior: "smooth" });
    });
    li.querySelector('[data-act="forget"]')!.addEventListener("click", () => {
      forgetHeldProof(p.proofCborHex);
      renderHeld();
      renderLevel();
    });
    list.appendChild(li);
  }
}

// --------------------------------------------------------------------------
// verify panel (offline)
// --------------------------------------------------------------------------

function runVerify() {
  const out = $("verify-result");
  out.hidden = false;
  try {
    const proof = decodeAnteProof(proofCborFromHex(($("verify-input") as HTMLTextAreaElement).value));
    const need = Number(($("verify-bits") as HTMLInputElement).value) || 0;
    const result = verifyAnteProof(proof, need);
    if (result.ok) {
      out.className = "result ok";
      out.textContent = `valid — identity ${fingerprint(proof.identityVk)} showed ${result.bits} bits for "${proof.purpose}"`;
    } else {
      out.className = "result err";
      out.textContent = `rejected — ${result.error}`;
    }
  } catch (err) {
    out.className = "result err";
    out.textContent = `could not parse: ${(err as Error).message}`;
  }
}

// --------------------------------------------------------------------------
// wiring
// --------------------------------------------------------------------------

function wireStaticHandlers() {
  const sBits = $("strengthen-bits") as HTMLInputElement;
  sBits.addEventListener("input", () => ($("strengthen-bits-out").textContent = sBits.value));
  const aBits = $("action-bits") as HTMLInputElement;
  aBits.addEventListener("input", () => ($("action-bits-out").textContent = aBits.value));

  $("strengthen-go").addEventListener("click", () =>
    runGrindPanel({
      purpose: IDENTITY_LEVEL_PURPOSE,
      targetBits: Number(sBits.value),
      progressId: "strengthen-progress",
      buttonId: "strengthen-go",
    }),
  );

  $("action-go").addEventListener("click", () => {
    const purpose = ($("action-purpose") as HTMLInputElement).value.trim();
    if (!purpose) {
      $("action-progress").hidden = false;
      $("action-progress").textContent = "enter a purpose string first";
      return;
    }
    void runGrindPanel({
      purpose,
      targetBits: Number(aBits.value),
      progressId: "action-progress",
      buttonId: "action-go",
    });
  });

  $("verify-go").addEventListener("click", runVerify);

  document.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const el = document.getElementById(btn.dataset.copy!);
      if (el?.textContent) void navigator.clipboard?.writeText(el.textContent);
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

void boot();
