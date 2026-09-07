// The ante identity UI. One identity per user, held by the delegate; you raise
// its level by grinding proof-of-work, and it's published to the registry so
// any app can read it. All the ante plumbing is in @ante/client.

import "./style.css";

import deployments from "../../deployments.json";

import {
  AnteClient,
  decodeAnteProof,
  fingerprint,
  FreenetClient,
  identityCodeFromSeed,
  identityFingerprintFromCode,
  identitySeedFromCode,
  IDENTITY_LEVEL_PURPOSE,
  RegistryClient,
  registryConfigured,
  verifyAnteProof,
  bytesToHex,
  hexToBytes,
} from "@ante/client";

/// Absolute ceiling on the grind target — past this a grind runs for many
/// minutes and the input is meaningless.
const MAX_BITS = 32;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let ante: AnteClient | null = null;
let registry: RegistryClient | null = null;
let identityVk: Uint8Array | null = null;
/// The identity's registry level, or null when it has none yet / unknown.
let currentLevel: number | null = null;

function setConn(text: string, state: "ok" | "warn" | "err" | "") {
  const el = $("conn");
  el.textContent = text;
  el.className = `status ${state}`;
}

async function boot() {
  wireStaticHandlers();
  try {
    const fn = await FreenetClient.connect({
      onClose: (code, reason) => setConn(`connection closed: ${reason || code}`, "err"),
    });
    setConn("connected — registering the ante delegate…", "ok");
    ante = await AnteClient.attach(fn);
    if (registryConfigured()) registry = new RegistryClient(fn);

    showIdentity(await ante.identity());
    $("identity-panel").hidden = false;
    $("recovery-panel").hidden = false;
    $("action-panel").hidden = false;

    setConn(registry ? "ready" : "ready — no registry configured, level not tracked", "ok");
    await refreshLevel();
    void refreshGrants();
    void sweepPredecessors();
  } catch (err) {
    setConn(`could not reach the delegate: ${(err as Error).message}`, "err");
  }
}

/// Bring levels forward from registry generations stranded by a re-key.
///
/// Runs on every load, not once: a predecessor that never answered is recorded
/// unresolved rather than empty, so the sweep has to be repeatable. Only when
/// every generation has actually answered is there nothing left to look for.
async function sweepPredecessors() {
  const previous = deployments.contracts.registry.superseded;
  if (!registry || previous.length === 0) return;

  // Silent unless something happened to YOU. The sweep carries every proof it
  // finds, for every identity — so `carried` counts other people's records as
  // readily as your own, and reporting it in a panel headed "Your identity"
  // told a brand-new user that 5 levels had been "recovered" while their own
  // level still read unproven. Both statements were true and the pair was
  // nonsense. Only `carriedSelf` is about the person reading the screen.
  //
  // The rest stays silent for the reason it always did: a first-time visitor
  // does not need to hear about a search for records they never had, and "did
  // not answer" is a fact about the network they cannot act on — the sweep
  // already retries on the next load.
  const status = $("sweep-status");
  try {
    const r = await registry.carryForward(
      previous,
      deployments.contracts.registry.minBits,
      identityVk ?? undefined,
    );
    if (r.carriedSelf) {
      status.hidden = false;
      status.textContent = "your level was carried forward from an earlier registry";
      await refreshLevel();
    }
  } catch {
    status.hidden = true; // never let a background sweep break the page
  }
}

function showIdentity(vk: Uint8Array) {
  identityVk = vk;
  $("id-fingerprint").textContent = fingerprint(vk);
  $("id-vk").textContent = bytesToHex(vk);
}

// --------------------------------------------------------------------------
// backup & restore
// --------------------------------------------------------------------------

async function revealRecovery() {
  if (!ante) return;
  const btn = $("recovery-reveal") as HTMLButtonElement;
  const progress = $("recovery-progress");
  btn.disabled = true;
  progress.hidden = false;
  progress.textContent = "approve the prompt on your node…";
  try {
    const outcome = await ante.exportIdentity({
      onPrompt: () => (progress.textContent = "approve the prompt on your node (you have 60 s)…"),
    });
    if (outcome.kind === "denied") {
      progress.textContent = "cancelled — nothing was revealed";
      return;
    }
    $("recovery-code").textContent = identityCodeFromSeed(outcome.seed);
    $("recovery-out").hidden = false;
    progress.hidden = true;
  } catch (err) {
    progress.textContent = `failed: ${(err as Error).message}`;
  } finally {
    btn.disabled = false;
  }
}

/// Look for an identity left behind by an earlier delegate generation.
///
/// Deliberately a button rather than something that runs on load. Adopting one
/// raises two consent prompts, and a prompt nobody asked for is how people
/// learn to click through prompts.
async function findPrevious() {
  if (!ante) return;
  const btn = $("previous-find") as HTMLButtonElement;
  const status = $("previous-status");
  const list = $("previous-list");
  btn.disabled = true;
  status.hidden = false;
  status.textContent = "asking earlier versions…";
  list.innerHTML = "";

  try {
    const search = await ante.findStrandedIdentities(deployments.delegate.superseded);

    if (search.found.length === 0) {
      status.textContent =
        search.unresponsive.length > 0
          ? // Not "nothing found": a version this node never had looks exactly
            // like one that is broken, and neither proves an absence.
            `no earlier identity found — ${search.unresponsive.length} version${search.unresponsive.length === 1 ? "" : "s"} did not answer, which may just mean this node never had ${search.unresponsive.length === 1 ? "it" : "them"}`
          : "no earlier identity on this node";
      return;
    }

    status.textContent = `found ${search.found.length}`;
    for (const hit of search.found) {
      const li = document.createElement("li");
      const label = document.createElement("code");
      label.textContent = fingerprint(hit.verifyingKey);
      const take = document.createElement("button");
      take.textContent = "Use this identity";
      take.addEventListener("click", () => void adoptPrevious(hit, take, status));
      li.append(label, take);
      list.appendChild(li);
    }
  } catch (err) {
    status.textContent = `failed: ${(err as Error).message}`;
  } finally {
    btn.disabled = false;
  }
}

async function adoptPrevious(
  hit: { delegate: { key: string; codeHash: string }; verifyingKey: Uint8Array },
  btn: HTMLButtonElement,
  status: HTMLElement,
) {
  if (!ante) return;
  btn.disabled = true;
  status.textContent = "approve both prompts on your node…";
  try {
    const outcome = await ante.adoptStrandedIdentity(hit.delegate);
    if (outcome.kind === "denied") {
      status.textContent = "cancelled — your identity is unchanged";
      return;
    }
    showIdentity(outcome.verifyingKey);
    currentLevel = null;
    $("previous-list").innerHTML = "";
    status.textContent = `recovered — this device is now ${fingerprint(outcome.verifyingKey)}`;
    await refreshLevel();
    void refreshGrants();
    void sweepPredecessors();
  } catch (err) {
    status.textContent = `failed: ${(err as Error).message}`;
  } finally {
    btn.disabled = false;
  }
}

function previewRestore() {
  const raw = ($("restore-input") as HTMLTextAreaElement).value.trim();
  const preview = $("restore-preview");
  if (!raw) {
    preview.textContent = "";
    return;
  }
  try {
    preview.textContent = `Restores identity ${identityFingerprintFromCode(raw)}.`;
    preview.className = "muted";
  } catch (err) {
    preview.textContent = (err as Error).message;
    preview.className = "muted err";
  }
}

async function runRestore() {
  if (!ante) return;
  const btn = $("restore-go") as HTMLButtonElement;
  const progress = $("restore-progress");
  const raw = ($("restore-input") as HTMLTextAreaElement).value.trim();

  let seed: Uint8Array;
  try {
    seed = identitySeedFromCode(raw);
  } catch (err) {
    progress.hidden = false;
    progress.textContent = (err as Error).message;
    return;
  }

  btn.disabled = true;
  progress.hidden = false;
  progress.textContent = "approve the prompt on your node (you have 60 s)…";
  try {
    const outcome = await ante.importIdentity(seed, {
      onPrompt: () => (progress.textContent = "approve the prompt on your node (you have 60 s)…"),
    });
    if (outcome.kind === "denied") {
      progress.textContent = "cancelled — your identity is unchanged";
      return;
    }
    showIdentity(outcome.verifyingKey);
    currentLevel = null;
    ($("restore-input") as HTMLTextAreaElement).value = "";
    $("restore-preview").textContent = "";
    $("recovery-out").hidden = true;
    ($("recovery-restore") as HTMLDetailsElement).open = false;
    progress.textContent = `restored — this device is now identity ${fingerprint(outcome.verifyingKey)}`;
    await refreshLevel();
    void refreshGrants();
  } catch (err) {
    progress.textContent = `failed: ${(err as Error).message}`;
  } finally {
    btn.disabled = false;
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
    currentLevel === null ? (registry ? "unproven" : "not tracked") : `${currentLevel} bits`;

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
  $("improve-go").textContent =
    currentLevel === null ? `Prove identity — ${n} bits` : `Improve to ${n} bits`;
}

function gridProgress(el: HTMLElement) {
  el.hidden = false;
  return (tried: number, hps: number) => {
    el.textContent = `grinding — ${tried.toLocaleString()} hashes (${Math.round(hps).toLocaleString()}/s)`;
  };
}

async function runImprove() {
  const btn = $("improve-go") as HTMLButtonElement;
  const progress = $("improve-progress");
  const target = Number(($("improve-bits") as HTMLInputElement).value);
  if (!ante || !Number.isFinite(target) || target < 1) return;

  btn.disabled = true;
  progress.hidden = false;
  try {
    const outcome = await ante.commit(IDENTITY_LEVEL_PURPOSE, {
      minBits: target,
      onProgress: gridProgress(progress),
      onPrompt: () => {
        progress.textContent = "approve the prompt on your node (you have 60 s)…";
      },
    });
    if (outcome.kind === "denied") {
      progress.textContent = "you declined the prompt — nothing was signed";
      return;
    }

    const v = verifyAnteProof(outcome.proof, 0);
    const bits = v.ok ? v.bits : target;

    if (registry) {
      progress.textContent = `signed ${bits} bits — publishing to the registry…`;
      await registry.publishProof(outcome.bytes);
    }
    currentLevel = Math.max(currentLevel ?? 0, bits);
    renderLevel();
    progress.textContent = registry
      ? `done — your identity is at ${currentLevel} bits`
      : `signed ${bits} bits (no registry configured, so it isn't recorded)`;
    void refreshLevel();
    void refreshGrants();
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
    const outcome = await ante.commit(purpose, {
      minBits: target,
      onProgress: gridProgress(progress),
      onPrompt: () => {
        progress.textContent = "approve the prompt on your node (you have 60 s)…";
      },
    });
    if (outcome.kind === "denied") {
      progress.textContent = "you declined the prompt — nothing was signed";
      return;
    }
    const v = verifyAnteProof(outcome.proof, 0);
    progress.textContent = `signed — ${v.ok ? v.bits : target} bits for "${purpose}"`;
    ($("action-proof") as HTMLElement).textContent = bytesToHex(outcome.bytes);
    result.hidden = false;
    void refreshGrants();
  } catch (err) {
    progress.textContent = `failed: ${(err as Error).message}`;
  } finally {
    btn.disabled = false;
  }
}

// --------------------------------------------------------------------------
// connected apps ("always allow" grants)
// --------------------------------------------------------------------------

const DEC = new TextDecoder();

function grantLabel(tag: Uint8Array): string {
  const s = DEC.decode(tag);
  if (s.startsWith("webapp:")) return `app ${bytesToHex(tag.slice(7)).slice(0, 16)}…`;
  if (s.startsWith("delegate:")) return `delegate ${bytesToHex(tag.slice(9)).slice(0, 16)}…`;
  return s || "unknown";
}

async function refreshGrants() {
  if (!ante) return;
  let grants: Uint8Array[] = [];
  try {
    grants = await ante.listGrants();
  } catch {
    return;
  }
  $("grants-panel").hidden = grants.length === 0;
  const list = $("grants-list");
  list.innerHTML = "";
  for (const tag of grants) {
    const li = document.createElement("li");
    li.className = "grant-row";
    const name = document.createElement("code");
    name.textContent = grantLabel(tag);
    const revoke = document.createElement("button");
    revoke.className = "ghost";
    revoke.textContent = "revoke";
    revoke.addEventListener("click", async () => {
      revoke.disabled = true;
      try {
        await ante!.revokeGrant(tag);
        await refreshGrants();
      } catch (err) {
        revoke.textContent = `failed: ${(err as Error).message}`;
      }
    });
    li.append(name, revoke);
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
  ($("home-link") as HTMLAnchorElement).href =
    `/v1/contract/web/${deployments.sites.home.contract}/`;
  ($("improve-bits") as HTMLInputElement).addEventListener("input", updateImproveLabel);
  $("improve-go").addEventListener("click", () => void runImprove());
  $("recovery-reveal").addEventListener("click", () => void revealRecovery());
  $("previous-find").addEventListener("click", () => void findPrevious());
  ($("restore-input") as HTMLTextAreaElement).addEventListener("input", previewRestore);
  $("restore-go").addEventListener("click", () => void runRestore());
  $("action-go").addEventListener("click", () => void runAction());
  $("verify-go").addEventListener("click", runVerify);

  document.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const el = document.getElementById(btn.dataset.copy!);
      if (el?.textContent) copyText(el.textContent, btn);
    });
  });
}

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
