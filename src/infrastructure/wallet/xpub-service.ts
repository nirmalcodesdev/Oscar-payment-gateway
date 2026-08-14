import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";
import { bytesToHex, type Address } from "viem";
import { publicKeyToAddress } from "viem/accounts";

const mainnetVersions = { public: 0x0488b21e, private: 0x0488ade4 } as const;
const testnetVersions = { public: 0x043587cf, private: 0x04358394 } as const;

export type WalletNetwork = "mainnet" | "testnet";

export interface ValidatedXpub {
  readonly network: WalletNetwork;
  readonly fingerprint: string;
  readonly sampleAddress: Address;
}

function expectedVersions(network: WalletNetwork) {
  return network === "mainnet" ? mainnetVersions : testnetVersions;
}

export function validateXpub(
  value: string,
  expectedNetwork: WalletNetwork,
): ValidatedXpub {
  if (!/^(?:xpub|tpub)[1-9A-HJ-NP-Za-km-z]{80,120}$/.test(value)) {
    throw new Error("Wallet public key format is invalid");
  }
  let key: HDKey;
  try {
    key = HDKey.fromExtendedKey(value, expectedVersions(expectedNetwork));
  } catch {
    throw new Error("Wallet public key checksum or network is invalid");
  }
  if (key.privateKey !== null || key.publicKey === null) {
    throw new Error("Wallet public key is not public-only");
  }
  let child: HDKey;
  try {
    child = key.deriveChild(0);
  } catch {
    throw new Error("Wallet public key cannot derive a receiving child");
  }
  if (child.publicKey === null) throw new Error("Wallet child public key is missing");
  const uncompressed = secp256k1.Point.fromBytes(child.publicKey).toBytes(false);
  const sampleAddress = publicKeyToAddress(bytesToHex(uncompressed));
  const fingerprint = key.fingerprint.toString(16).padStart(8, "0");
  return { network: expectedNetwork, fingerprint, sampleAddress };
}
