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
/// by the UI. Registration is idempotent — re-registering the same bytes does
/// not touch the delegate's stored secrets. Resolves with the delegate key
/// from the ack (the node recomputes it from code+params; the key fields sent
/// here are required by the schema but not trusted).
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
  // `cipher`/`nonce` are required by the FlatBuffers schema but the node
  // ignores them (since freenet-core #4140 the per-delegate key is derived
  // from the node's own KEK). Send a stable value keyed to the delegate — a
  // random one per call would strand secrets on any node that still honours
  // the field.
  const cipher = address.keyBytes.slice(0, 32);
  const nonce = address.codeHashBytes.slice(0, 24);
  const register = new RegisterDelegateT(container, Array.from(cipher), Array.from(nonce));
  const delegateReq = new DelegateRequest(DelegateRequestType.RegisterDelegate, register);
  const clientReq = new ClientRequestT(ClientRequestType.DelegateRequest, delegateReq);

  const pending = client.awaitDelegateResponse(address.keyBytes);
  (client.api as unknown as { sendRequest(r: ClientRequestT): void }).sendRequest(clientReq);
  const ack = await pending;
  return Uint8Array.from(ack.key?.key ?? []);
}

// OutboundDelegateMsgType. Named rather than compared as bare integers so a
// "nothing came back" failure can say WHAT came back instead — the difference
// between an empty response and one carrying only a context update is the whole
// diagnosis, and without it both read as silence.
const OUTBOUND_KIND: Record<number, string> = {
  0: "none",
  1: "ApplicationMessage",
  2: "RequestUserInput",
  3: "ContextUpdated",
};
const OUTBOUND_APPLICATION_MESSAGE = 1;

export interface DelegateReply {
  /// ApplicationMessage payloads in the response — the delegate's answers.
  payloads: Uint8Array[];
  /// Every outbound kind the node sent back, in order, named. Empty when the
  /// response carried nothing at all. Only used to describe a failure.
  kinds: string[];
}

/// Describe a reply that carried no answer, for an error message. "No response"
/// and "a response with no answer in it" are different faults with different
/// causes, and telling them apart from a user's bug report is otherwise
/// impossible.
export function describeEmptyReply(reply: DelegateReply): string {
  if (reply.kinds.length === 0) return "the node returned an empty response";
  return `the node returned only ${reply.kinds.join(", ")}`;
}

function readReply(response: DelegateResponse): DelegateReply {
  const payloads: Uint8Array[] = [];
  const kinds: string[] = [];
  for (const outbound of response.values ?? []) {
    kinds.push(OUTBOUND_KIND[outbound.inboundType] ?? `unknown(${outbound.inboundType})`);
    if (outbound.inboundType === OUTBOUND_APPLICATION_MESSAGE) {
      const msg = outbound.inbound as { payload?: number[] } | null;
      if (msg?.payload?.length) payloads.push(Uint8Array.from(msg.payload));
    }
    // A RequestUserInput is consumed by the node's runtime (it drives the
    // consent prompt) and never reaches the client — the one DelegateResponse
    // we get back carries the post-approval outcome.
  }
  return { payloads, kinds };
}

/// Send one ApplicationMessage payload to the delegate and read the response.
/// For a `Commit`, the node holds this open until the user answers the consent
/// prompt, so pass a `timeoutMs` past the node's own 60 s window.
export async function sendToDelegate(
  client: FreenetClient,
  address: DelegateAddress,
  payload: Uint8Array,
  timeoutMs?: number,
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

  const pending = client.awaitDelegateResponse(address.keyBytes, timeoutMs);
  (client.api as unknown as { sendRequest(r: ClientRequestT): void }).sendRequest(clientReq);
  return readReply(await pending);
}
