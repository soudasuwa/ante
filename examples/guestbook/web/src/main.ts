// UI glue. Reads entries from the guestbook contract, groups them by how much
// work each author committed, and drives the compose form. The two ante calls
// it makes (`proofForPost`, `checkProof`) live in ./ante.ts.

import "./style.css";

import { FreenetClient, fingerprint, type AnteProof } from "@ante/client";

import { attachAnte, checkProof, proofForPost } from "./ante";
import {
  contractId,
  Guestbook,
  GUESTBOOK_MIN_BITS,
  MAX_NAME_BYTES,
  MAX_TEXT_BYTES,
  type Entry,
} from "./guestbook";

// ── commitment tiers (app policy, nothing ante-specific) ──────────────────
// Buckets of 4 bits. Each +1 bit is ~2× the work, so a tier up is ~16×.
const TIERS = [
  { min: 28, label: "28+ bits" },
  { min: 24, label: "24–27 bits" },
  { min: 20, label: "20–23 bits" },
  { min: GUESTBOOK_MIN_BITS, label: `${GUESTBOOK_MIN_BITS}–19 bits` },
];

function tierOf(bits: number) {
  return TIERS.find((t) => bits >= t.min) ?? TIERS[TIERS.length - 1];
}

interface Shown {
  entry: Entry;
  bits: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let gb: Guestbook | null = null;
let ante: Awaited<ReturnType<typeof attachAnte>> | null = null;

function status(text: string, kind: "" | "ok" | "err" = "") {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${kind}`;
}

async function boot() {
  $("post").addEventListener("click", () => void submit());

  if (!contractId()) {
    status("no guestbook contract configured — see the README", "err");
    return;
  }

  try {
    const fn = await FreenetClient.connect({
      onClose: (c, r) => status(`connection closed: ${r || c}`, "err"),
    });
    gb = new Guestbook(fn);
    status("connected — registering the ante delegate…");
    ante = await attachAnte(fn);
    $("compose").hidden = false;
    status("ready", "ok");
    await refresh();
  } catch (err) {
    status(`could not start: ${(err as Error).message}`, "err");
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
    const bits = checkProof(entry.proof);
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
    section.appendChild(h);
    for (const s of inTier) section.appendChild(entryCard(s));
    list.appendChild(section);
  }
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

async function submit() {
  if (!gb || !ante) return;
  const btn = $("post") as HTMLButtonElement;
  const progress = $("progress");
  const name = ($("name") as HTMLInputElement).value.trim();
  const text = ($("text") as HTMLTextAreaElement).value.trim();

  if (!name || !text) {
    progress.hidden = false;
    progress.textContent = "enter a name and a message first";
    return;
  }
  if (enc(name) > MAX_NAME_BYTES || enc(text) > MAX_TEXT_BYTES) {
    progress.hidden = false;
    progress.textContent = `too long — name ≤ ${MAX_NAME_BYTES} bytes, message ≤ ${MAX_TEXT_BYTES}`;
    return;
  }

  btn.disabled = true;
  progress.hidden = false;
  try {
    progress.textContent = `grinding proof of work (≥ ${GUESTBOOK_MIN_BITS} bits)…`;
    const proof: AnteProof | null = await proofForPost(ante, {
      onProgress: (tried, hps) => {
        progress.textContent = `grinding — ${tried.toLocaleString()} hashes (${Math.round(hps).toLocaleString()}/s)`;
      },
      onPrompt: () => {
        progress.textContent = "approve the prompt on your node (you have 60 s)…";
      },
    });
    if (!proof) {
      progress.textContent = "you declined the prompt — nothing was posted";
      return;
    }

    progress.textContent = "posting…";
    await gb.post({ name, text, proof });
    ($("text") as HTMLTextAreaElement).value = "";
    progress.textContent = "posted.";
    await refresh();
  } catch (err) {
    progress.textContent = `failed: ${(err as Error).message}`;
  } finally {
    btn.disabled = false;
  }
}

const enc = (s: string) => new TextEncoder().encode(s).length;

void boot();
