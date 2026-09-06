// The ante identity UI. One identity per user, held by the delegate; you raise
// its level by grinding proof-of-work, and it's published to the registry so
// any app can read it. Vanilla TS, one module.

import "./style.css";

import { AnteClient } from "./ante-client";
import { decodeAnteProof, fingerprint, IDENTITY_LEVEL_PURPOSE, verifyAnteProof } from "./ante-proof";
import { base64ToBytes, registerDelegate, type DelegateAddress } from "./delegate-api";
import {
  ANTE_DELEGATE_CODE_HASH_BYTES,
  ANTE_DELEGATE_KEY_BYTES,
  ANTE_DELEGATE_WASM_B64,
  delegateIsBuilt,
} from "./delegate-wasm";
import { FreenetClient } from "./freenet";
// Inlined as a blob: worker — a separate-file worker can't load in the
// gateway's opaque-origin sandbox iframe; the sandbox CSP allows blob:.
import PowWorker from "./pow-worker?worker&inline";
import type { PowWorkerMessage, PowWorkerRequest } from "./pow-worker";
import { RegistryClient, registryConfigured } from "./registry";
import { bytesToHex, hexToBytes } from "./util";

/// Absolute ceiling on the grind target — past this a grind runs for many
/// minutes and the slider is meaningless.
const MAX_BITS = 32;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let ante: AnteClient | null = null;
let registry: RegistryClient | null = null;
let identityVk: Uint8Array | null = null;
/// The identity's registry level, or null when it has none yet / unknown.
let currentLevel: number | null = null;

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

  if (!delegateIsBuilt()) {
    setConn("the ante delegate is not built — run ./scripts/sync-delegate.sh, then reload", "err");
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
    $("id-fingerprint").textContent = fingerprint(identityVk);
    $("id-vk").textContent = bytesToHex(identityVk);
    $("identity-panel").hidden = false;
    $("action-panel").hidden = false;

    setConn(registry ? "ready" : "ready — no registry configured, level not tracked", "ok");
    await refreshLevel();
  } catch (err) {
    setConn(`could not reach the delegate: ${(err as Error).message}`, "err");
  }
}

// --------------------------------------------------------------------------
// identity level
// --------------------------------------------------------------------------

async function refreshLevel() {
  if (registry && identityVk) {
    try {
      currentLevel = await registry.readLevel(identityVk);
    } catch {
      // keep whatever we last knew
    }
  }
  renderLevel();
}

function renderLevel() {
  $("id-level").textContent =
    currentLevel === null
      ? registry
        ? "unproven"
        : "not tracked"
      : `${currentLevel} bits`;

  const floor = (currentLevel ?? 0) + 1;
  const input = $("improve-bits") as HTMLInputElement;
  input.min = String(floor);
  input.max = String(MAX_BITS);
  const wanted = Number(input.value);
  if (!wanted || wanted < floor) {
    input.value = String(currentLevel === null ? Math.max(floor, 18) : floor);
  }
  updateImproveLabel();
}

function updateImproveLabel() {
  const n = Number(($("improve-bits") as HTMLInputElement).value) || 0;
  $("improve-go").textContent = currentLevel === null ? `Prove identity — ${n} bits` : `Improve to ${n} bits`;
}

// --------------------------------------------------------------------------
// grind
// --------------------------------------------------------------------------

function grind(
  challenge: Uint8Array,
  targetBits: number,
  onProgress: (tried: number, hps: number) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new PowWorker();
    const started = performance.now();
    worker.onmessage = (event: MessageEvent<PowWorkerMessage>) => {
      const msg = event.data;
      const elapsed = (performance.now() - started) / 1000;
      onProgress(msg.tried, elapsed > 0 ? msg.tried / elapsed : 0);
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

function progressReporter(el: HTMLElement) {
  el.hidden = false;
  return (tried: number, hps: number) => {
    el.textContent = `grinding — ${tried.toLocaleString()} hashes (${Math.round(hps).toLocaleString()}/s)`;
  };
}

// --------------------------------------------------------------------------
// improve identity
// --------------------------------------------------------------------------

async function runImprove() {
  const btn = $("improve-go") as HTMLButtonElement;
  const progress = $("improve-progress");
  const target = Number(($("improve-bits") as HTMLInputElement).value);
  if (!ante || !Number.isFinite(target) || target < 1) return;

  btn.disabled = true;
  progress.hidden = false;
  try {
    progress.textContent = "asking the delegate for the challenge…";
    const challenge = await ante.challenge(IDENTITY_LEVEL_PURPOSE);

    const nonce = await grind(challenge, target, progressReporter(progress));

    progress.textContent = "grind done — approve the prompt on your node (you have 60 s)";
    const outcome = await ante.commit(IDENTITY_LEVEL_PURPOSE, nonce, target, () => {
      progress.textContent = "approve the prompt on your node (you have 60 s)…";
    });
    if (outcome.kind === "denied") {
      progress.textContent = "you declined the prompt — nothing was signed";
      return;
    }

    const v = verifyAnteProof(outcome.proof, 0);
    const bits = v.ok ? v.bits : target;

    if (registry) {
      progress.textContent = `signed ${bits} bits — publishing to the registry…`;
      await registry.publishProof(outcome.proofCbor);
    }
    currentLevel = Math.max(currentLevel ?? 0, bits);
    renderLevel();
    progress.textContent = registry
      ? `done — your identity is at ${currentLevel} bits`
      : `signed ${bits} bits (no registry configured, so it isn't recorded)`;
    void refreshLevel();
  } catch (err) {
    progress.textContent = `failed: ${(err as Error).message}`;
  } finally {
    btn.disabled = false;
  }
}

// --------------------------------------------------------------------------
// commit for an action (the "what an app does" demo)
// --------------------------------------------------------------------------

async function runAction() {
  const btn = $("action-go") as HTMLButtonElement;
  const progress = $("action-progress");
  const result = $("action-result");
  const purpose = ($("action-purpose") as HTMLInputElement).value.trim();
  const target = Number(($("action-bits") as HTMLInputElement).value);
  if (!ante) return;
  if (!purpose) {
    progress.hidden = false;
    progress.textContent = "enter a purpose string first";
    return;
  }

  btn.disabled = true;
  progress.hidden = false;
  result.hidden = true;
  try {
    progress.textContent = "asking the delegate for the challenge…";
    const challenge = await ante.challenge(purpose);

    const nonce = await grind(challenge, target, progressReporter(progress));

    progress.textContent = "grind done — approve the prompt on your node (you have 60 s)";
    const outcome = await ante.commit(purpose, nonce, target, () => {
      progress.textContent = "approve the prompt on your node (you have 60 s)…";
    });
    if (outcome.kind === "denied") {
      progress.textContent = "you declined the prompt — nothing was signed";
      return;
    }

    const v = verifyAnteProof(outcome.proof, 0);
    progress.textContent = `signed — ${v.ok ? v.bits : target} bits for "${purpose}"`;
    ($("action-proof") as HTMLElement).textContent = bytesToHex(outcome.proofCbor);
    result.hidden = false;
  } catch (err) {
    progress.textContent = `failed: ${(err as Error).message}`;
  } finally {
    btn.disabled = false;
  }
}

// --------------------------------------------------------------------------
// verify panel (offline)
// --------------------------------------------------------------------------

function runVerify() {
  const out = $("verify-result");
  out.hidden = false;
  try {
    const proof = decodeAnteProof(hexToBytes(($("verify-input") as HTMLTextAreaElement).value));
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
  ($("improve-bits") as HTMLInputElement).addEventListener("input", updateImproveLabel);
  $("improve-go").addEventListener("click", () => void runImprove());
  $("action-go").addEventListener("click", () => void runAction());
  $("verify-go").addEventListener("click", runVerify);

  document.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const el = document.getElementById(btn.dataset.copy!);
      if (el?.textContent) copyText(el.textContent, btn);
    });
  });
}

/// Copy to clipboard; the gateway sandbox often doesn't grant the Clipboard
/// API, so fall back to selecting the text and flashing the button.
function copyText(text: string, btn: HTMLButtonElement) {
  const flash = (label: string) => {
    const prev = btn.textContent;
    btn.textContent = label;
    setTimeout(() => (btn.textContent = prev), 1200);
  };
  navigator.clipboard?.writeText(text).then(
    () => flash("copied"),
    () => selectInto(text, flash),
  );
  if (!navigator.clipboard) selectInto(text, flash);
}

function selectInto(text: string, flash: (label: string) => void) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  flash(ok ? "copied" : "select + ⌘/Ctrl-C");
}

void boot();
