// @ante/client — the browser client for ante.
//
// A producer app:
//   const fn = await FreenetClient.connect();
//   const ante = await AnteClient.attach(fn);
//   const { bytes } = await ante.commit("myapp:msg:v1", { minBits: 18 });
//   // attach `bytes` to your contract write
//
// A verifier (client-side): verifyAnteProof(decodeAnteProof(bytes), minBits).
// (In a contract, link the `ante-core` Rust crate instead.)

export { FreenetClient, contractKeyFromId, type FreenetEvents } from "./freenet";
export {
  AnteClient,
  type CommitOutcome,
  type CommitOptions,
  type PromptOptions,
  type ExportOutcome,
  type ImportOutcome,
} from "./ante";
export {
  identityCodeFromSeed,
  identitySeedFromCode,
  identityFingerprintFromCode,
} from "./recovery";
export { RegistryClient, registryConfigured, ANTE_REGISTRY_CONTRACT_ID } from "./registry";

export {
  type AnteProof,
  type VerifyResult,
  verifyAnteProof,
  decodeAnteProof,
  decodeAnteProofValue,
  anteProofToCborValue,
  proofBits,
  challengeBytes,
  fingerprint,
  IDENTITY_LEVEL_PURPOSE,
  MAX_PURPOSE_BYTES,
} from "./ante-proof";

// Low-level pieces, for callers running their own grinder or wire handling.
export { Grinder, grind, powBits, powDigest, leadingZeroBits } from "./pow";
// A CBOR codec matching ciborium — for building your own contract's wire types.
export {
  cborEncode,
  cborDecode,
  type CborValue,
  mapGet,
  asBytes,
  asNumber,
  asString,
} from "./cbor";
export { bytesToHex, hexToBytes, bytesEqual, base58, base58decode } from "./util";
