// UI glue. Reads entries from the guestbook contract, groups them by how much
// work each author committed, and drives the compose form. The two ante calls
// it makes (`proofForPost`, `checkProof`) live in ./ante.ts.

import "./style.css";

import { FreenetClient, fingerprint } from "@ante/client";

import deployments from "../../../../deployments.json";

import { attachAnte, carryableEntries, checkProof } from "./ante";
import { contentPurpose } from "./guestbook";
import { probeGenerations } from "@ante/client";

import {
  contractId,
  entriesInState,
  Guestbook,
  GUESTBOOK_MIN_BITS,
  MAX_NAME_BYTES,
  MAX_TEXT_BYTES,
  type Entry,
} from "./guestbook";

// ── commitment tiers (app policy, nothing ante-specific) ──────────────────
//
// Bands of 2 bits, so each tier is ~4x the work of the one below. Calibrated to
// what a browser can actually do: pure-JS blake3 runs ~200k hashes/s, and
// expected tries is 2^bits. Wider bands (or a 28+ tier) would be decorative —
// nobody grinds for 20 minutes to sign a guestbook.
const TIERS = [
  { min: 24, label: "24+ bits", effort: "minutes of work" },
  { min: 22, label: "22–23 bits", effort: "~30 seconds" },
  { min: 20, label: "20–21 bits", effort: "~10 seconds" },
  { min: 18, label: "18–19 bits", effort: "~2 seconds" },
  { min: GUESTBOOK_MIN_BITS, label: `${GUESTBOOK_MIN_BITS}–17 bits`, effort: "the minimum" },
];

function tierOf(bits: number) {
  return TIERS.find((t) => bits >= t.min) ?? TIERS[TIERS.length - 1];
}

interface Shown {
  entry: Entry;
  bits: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/// The ante identity app, for the "back up your key" link. Fixed at build time
/// and deliberately NOT overridable at runtime.
///
/// This link asks the visitor to go and handle their recovery code, so aiming
/// it is the most dangerous thing a query parameter could do here: a link to
/// the real guestbook with someone else's app in the query string sends people
/// to a convincing clone that asks them to paste the seed. Hardcoding costs
/// nothing — an `fdev website` address is blake3(container_wasm ‖
/// publisher_key), so unlike a data contract this URL is permanent across
/// every update.
const ANTE_APP = deployments.sites.vault.contract;

let gb: Guestbook | null = null;
let gbClient: import("@ante/client").FreenetClient | null = null;
let ante: Awaited<ReturnType<typeof attachAnte>> | null = null;
/// The in-flight grind, if the compose form is currently working.
/// Bumped whenever a grind is started or abandoned. A worker whose generation
/// no longer matches is stale: it must not paint the readout, and if it arrives
/// after a cancel it must be terminated rather than left running forever.
let generation = 0;

function status(text: string, kind: "" | "ok" | "err" = "") {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${kind}`;
}

async function boot() {
  ($("home-link") as HTMLAnchorElement).href =
    `/v1/contract/web/${deployments.sites.home.contract}/`;
  $("start").addEventListener("click", () => void signAndPost());

  if (!contractId()) {
    status("no guestbook contract configured — see the README", "err");
    return;
  }

  try {
    const fn = await FreenetClient.connect({
      onClose: (c, r) => status(`connection closed: ${r || c}`, "err"),
    });
    gb = new Guestbook(fn);
    gbClient = fn;
    status("connected — registering the ante delegate…");
    ante = await attachAnte(fn);
    $("compose").hidden = false;
    status("ready", "ok");
    await refresh();
    void sweepPredecessors();
  } catch (err) {
    status(`could not start: ${(err as Error).message}`, "err");
  }
}

/// Bring entries forward from generations stranded by a contract re-key.
///
/// Runs on every load, not once: a predecessor that never answered is recorded
/// unresolved rather than empty, so the sweep must be repeatable. The ante
/// pieces are `entriesInState` -> `carryableEntries` (what is still valid) and
/// `postMany` (the ordinary write path, so the contract re-checks every entry).
async function sweepPredecessors() {
  const previous = deployments.contracts.guestbook.superseded;
  if (!gb || previous.length === 0) return;

  // Silent unless there is something to say. A first-time visitor has no
  // earlier guestbooks, and "did not answer" is not actionable — the sweep
  // retries itself. Recovered and dropped posts DO matter: they explain why
  // the list just changed, or why old posts are missing.
  const note = $("sweep-status");
  try {
    const r = await probeGenerations(gbClient!, deployments.contracts.guestbook.instance, previous, {
      decode: (bytes) => carryableEntries(entriesInState(bytes)),
      submit: (entries) => gb!.postMany(entries),
      chunkSize: 32,
    });

    const parts: string[] = [];
    if (r.carried > 0) parts.push(`recovered ${r.carried} post${r.carried === 1 ? "" : "s"}`);
    if (r.dropped > 0) parts.push(`${r.dropped} too old to carry forward`);

    if (parts.length > 0) {
      note.hidden = false;
      note.textContent = parts.join(" · ");
      if (r.carried > 0) await refresh();
    }
  } catch {
    note.hidden = true; // a background sweep must never break the page
  }
}

async function refresh() {
  if (!gb) return;
  let entries: Entry[];
  try {
    entries = await gb.entries();
  } catch (err) {
    status(`could not read the guestbook: ${(err as Error).message}`, "err");
    return;
  }

  // Re-verify every proof client-side; drop anything that does not check out.
  const shown: Shown[] = [];
  for (const entry of entries) {
    const bits = checkProof(entry);
    if (bits !== null) shown.push({ entry, bits });
  }

  render(shown);
}

function render(shown: Shown[]) {
  const list = $("entries");
  list.innerHTML = "";

  if (shown.length === 0) {
    list.innerHTML = `<p class="empty">No entries yet. Be the first.</p>`;
    return;
  }

  for (const tier of TIERS) {
    const inTier = shown
      .filter((s) => tierOf(s.bits).min === tier.min)
      .sort((a, b) => b.entry.proof.ts - a.entry.proof.ts); // newest first
    if (inTier.length === 0) continue;

    const section = document.createElement("section");
    section.className = "tier";
    const h = document.createElement("h2");
    h.textContent = tier.label;
    const hint = document.createElement("span");
    hint.className = "tier-effort";
    hint.textContent = tier.effort;
    h.appendChild(hint);
    section.appendChild(h);
    for (const s of inTier) section.appendChild(entryCard(s));
    list.appendChild(section);
  }
}

/// Shown once the visitor has actually posted. Deliberately not on page load:
/// someone who only reads the guestbook should not have a key created for them,
/// and `GetIdentity` would create one just by asking.
///
/// The wording says nothing about the key being *new*. It fires after every
/// post, and there is no way to tell a freshly minted identity from a restored
/// or long-standing one — `load_or_create` does not report which branch it
/// took. Claiming "your node made it just now" was therefore false for anyone
/// on their second post, and for anyone who had restored from a recovery code.
function showIdentityNote(identityVk: Uint8Array) {
  $("my-fingerprint").textContent = fingerprint(identityVk);
  ($("backup-link") as HTMLAnchorElement).href = `/v1/contract/web/${ANTE_APP}/`;
  $("identity-note").hidden = false;
}

function entryCard({ entry, bits }: Shown): HTMLElement {
  const card = document.createElement("article");
  card.className = "entry";

  const head = document.createElement("div");
  head.className = "entry-head";
  const name = document.createElement("strong");
  name.textContent = entry.name;
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = `${bits} bits`;
  badge.title = `identity ${fingerprint(entry.proof.identityVk)}`;
  head.append(name, badge);

  const body = document.createElement("p");
  body.className = "entry-text";
  body.textContent = entry.text;

  card.append(head, body);
  return card;
}

// ── composing: grind, watch it climb, post when you're happy ──────────────
//
// The grind is open-ended rather than aimed at a fixed bar. That is the whole
// point of the tiers: how high your message sits is how long you were willing
// to wait, decided while you watch, on whatever hardware you happen to have.

function setComposeState(state: "idle" | "grinding" | "posting") {
  const busy = state !== "idle";
  ($("start") as HTMLButtonElement).disabled = busy;
  ($("start") as HTMLButtonElement).textContent = busy ? "Working…" : "Sign & post";
  $("grind-panel").hidden = !busy;
  $("start-hint").hidden = busy;
  // The proof binds this exact wording and this exact level, so all three are
  // fixed for the duration. Editing any of them would throw the work away.
  for (const id of ["name", "text", "level"]) {
    ($(id) as HTMLInputElement).disabled = busy;
  }
}

function renderGrind(elapsed: number, tried = 0) {
  // No live bit count any more. The target was chosen before the work started,
  // so the only honest thing to report is progress toward it — a climbing
  // number would imply a choice the user already made.
  $("grind-bits").textContent = "working…";
  $("grind-elapsed").textContent =
    `${elapsed.toFixed(0)}s · ${tried.toLocaleString()} hashes`;
}

function composeInput(): { name: string; text: string } | null {
  const progress = $("progress");
  const name = ($("name") as HTMLInputElement).value.trim();
  const text = ($("text") as HTMLTextAreaElement).value.trim();

  progress.hidden = false;
  if (!name || !text) {
    progress.textContent = "enter a name and a message first";
    return null;
  }
  if (enc(name) > MAX_NAME_BYTES || enc(text) > MAX_TEXT_BYTES) {
    progress.textContent = `too long — name ≤ ${MAX_NAME_BYTES} bytes, message ≤ ${MAX_TEXT_BYTES}`;
    return null;
  }
  progress.hidden = true;
  return { name, text };
}

/// Post at the level the user chose: one bounded operation, start to finish.
///
/// This used to be an open-ended grind the user stopped by hand, and that made
/// the consent prompt dishonest. It asked to spend "at least 16 bits (about a
/// second)" and then ran until someone clicked stop — so the estimate the user
/// agreed to bore no relation to what was actually spent. Choosing a level up
/// front means the prompt names the real cost, the work stops there, and the
/// second click disappears along with the problem.
async function signAndPost() {
  const input = composeInput();
  if (!ante || !gb || !input) return;

  const minBits = Number(($("level") as HTMLSelectElement).value);
  const progress = $("progress");
  const gen = ++generation;
  const started = performance.now();
  setComposeState("grinding");
  renderGrind(0, 0);

  try {
    const outcome = await ante.commit(contentPurpose(input.name, input.text), {
      minBits,
      onProgress: (tried) => {
        if (gen !== generation) return;
        renderGrind((performance.now() - started) / 1000, tried);
      },
      onPrompt: () => {
        progress.hidden = false;
        progress.textContent = "approve on your node to begin — nothing is spent yet";
      },
    });
    if (gen !== generation) return;

    if (outcome.kind === "denied") {
      progress.hidden = false;
      progress.textContent = "you declined — nothing was spent";
      setComposeState("idle");
      return;
    }

    progress.hidden = false;
    progress.textContent = "posting…";
    await gb.post({ ...input, proof: outcome.proof });
    ($("text") as HTMLTextAreaElement).value = "";
    const achieved = checkProof({ ...input, proof: outcome.proof }) ?? minBits;
    progress.textContent = `posted at ${achieved} bits.`;
    showIdentityNote(outcome.proof.identityVk);
    setComposeState("idle");
    await refresh();
  } catch (err) {
    progress.hidden = false;
    // Declining is the feature working; it must not read like a broken node.
    progress.textContent =
      (err as Error).name === "GrindDeniedError"
        ? "you declined — nothing was spent"
        : `failed: ${(err as Error).message}`;
    setComposeState("idle");
  }
}

const enc = (s: string) => new TextEncoder().encode(s).length;

void boot();
