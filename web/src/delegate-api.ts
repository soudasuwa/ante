// Delegate messaging over the raw FlatBuffers table types. Adapted from
// FreePlace's delegate-api.ts — the SDK (stdlib TS 0.2.0) has no public
// delegate-request builder, so this reaches for `(api as any).sendRequest`.
// Known-unstable seam: may break on any minor SDK bump.

import { DelegateRequest, DelegateResponse } from "@freenetorg/freenet-stdlib";
import { ApplicationMessageT } from "@freenetorg/freenet-stdlib/common";
import {
  ApplicationMessagesT,
  ClientRequestT,
  ClientRequestType,
  DelegateCodeT,
  DelegateContainerT,
  DelegateKeyT,
  DelegateRequestType,
  DelegateType,
  InboundDelegateMsgT,
  InboundDelegateMsgType,
  RegisterDelegateT,
  WasmDelegateV1T,
} from "@freenetorg/freenet-stdlib/client-request";

import type { FreenetClient } from "./freenet";

export interface DelegateAddress {
  /// blake3(code_hash || params) — the node's lookup key.
  keyBytes: number[];
  /// blake3(raw wasm bytes) — a different hash; both are required.
  codeHashBytes: number[];
}

export function base64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/// Register the delegate's WASM on the connected node. Delegates never
/// propagate over the network, so every user's node must be handed the bytes
/// by the UI. Registration is idempotent. Resolves with the delegate key from
/// the ack (the node recomputes it from code+params; the key fields sent here
/// are required by the schema but not trusted).
export async function registerDelegate(
  client: FreenetClient,
  address: DelegateAddress,
  wasm: Uint8Array,
): Promise<Uint8Array> {
  const code = new DelegateCodeT(Array.from(wasm), address.codeHashBytes);
  const key = new DelegateKeyT(address.keyBytes, address.codeHashBytes);
  const container = new DelegateContainerT(
    DelegateType.WasmDelegateV1,
    new WasmDelegateV1T([], code, key),
  );
  const cipher = new Uint8Array(32);
  const nonce = new Uint8Array(24);
  crypto.getRandomValues(cipher);
  crypto.getRandomValues(nonce);
  const register = new RegisterDelegateT(container, Array.from(cipher), Array.from(nonce));
  const delegateReq = new DelegateRequest(DelegateRequestType.RegisterDelegate, register);
  const clientReq = new ClientRequestT(ClientRequestType.DelegateRequest, delegateReq);

  const pending = client.awaitDelegateResponse(address.keyBytes);
  (client.api as unknown as { sendRequest(r: ClientRequestT): void }).sendRequest(clientReq);
  const ack = await pending;
  return Uint8Array.from(ack.key?.key ?? []);
}

const OUTBOUND_APPLICATION_MESSAGE = 1; // OutboundDelegateMsgType.common_ApplicationMessage
const OUTBOUND_REQUEST_USER_INPUT = 2; // OutboundDelegateMsgType.RequestUserInput

export interface DelegateReply {
  /// ApplicationMessage payloads in the response (the actual answers).
  payloads: Uint8Array[];
  /// True if the response also carried a RequestUserInput — i.e. the delegate
  /// raised a consent prompt and the real answer will arrive later.
  raisedPrompt: boolean;
}

function readReply(response: DelegateResponse): DelegateReply {
  const payloads: Uint8Array[] = [];
  let raisedPrompt = false;
  for (const outbound of response.values ?? []) {
    if (outbound.inboundType === OUTBOUND_APPLICATION_MESSAGE) {
      const msg = outbound.inbound as { payload?: number[] } | null;
      if (msg?.payload?.length) payloads.push(Uint8Array.from(msg.payload));
    } else if (outbound.inboundType === OUTBOUND_REQUEST_USER_INPUT) {
      raisedPrompt = true;
    }
  }
  return { payloads, raisedPrompt };
}

/// Send one ApplicationMessage payload to the delegate and read its immediate
/// reply. If the delegate raised a consent prompt, `raisedPrompt` is true and
/// `payloads` is usually empty — call [`awaitPromptResult`] next.
export async function sendToDelegate(
  client: FreenetClient,
  address: DelegateAddress,
  payload: Uint8Array,
): Promise<DelegateReply> {
  const appMsg = new ApplicationMessageT(Array.from(payload), [], false);
  const inbound = new InboundDelegateMsgT(
    InboundDelegateMsgType.common_ApplicationMessage,
    appMsg,
  );
  const delegateKey = new DelegateKeyT(address.keyBytes, address.codeHashBytes);
  const appMessages = new ApplicationMessagesT(delegateKey, [], [inbound]);
  const delegateReq = new DelegateRequest(DelegateRequestType.ApplicationMessages, appMessages);
  const clientReq = new ClientRequestT(ClientRequestType.DelegateRequest, delegateReq);

  const pending = client.awaitDelegateResponse(address.keyBytes);
  (client.api as unknown as { sendRequest(r: ClientRequestT): void }).sendRequest(clientReq);
  return readReply(await pending);
}

/// After a prompt was raised, wait for the follow-up response the node sends
/// once the user answers the shell overlay. `timeoutMs` is generous — the user
/// has to read and click.
export async function awaitPromptResult(
  client: FreenetClient,
  address: DelegateAddress,
  timeoutMs = 180_000,
): Promise<Uint8Array[]> {
  const response = await client.awaitDelegateResponse(address.keyBytes, timeoutMs);
  return readReply(response).payloads;
}
