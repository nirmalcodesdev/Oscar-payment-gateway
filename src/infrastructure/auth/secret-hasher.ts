import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
const version = "v1";
const defaultN = 65_536;
const defaultR = 8;
const defaultP = 1;
const keyLength = 64;

interface ScryptParameters {
  readonly n: number;
  readonly r: number;
  readonly p: number;
}

const defaultParameters: ScryptParameters = {
  n: defaultN,
  r: defaultR,
  p: defaultP,
};

function assertParameters(parameters: ScryptParameters): void {
  if (
    !Number.isInteger(parameters.n) ||
    parameters.n < 16_384 ||
    (parameters.n & (parameters.n - 1)) !== 0 ||
    !Number.isInteger(parameters.r) ||
    parameters.r < 1 ||
    parameters.r > 32 ||
    !Number.isInteger(parameters.p) ||
    parameters.p < 1 ||
    parameters.p > 16
  ) {
    throw new Error("Invalid password hashing parameters");
  }
}

function maxMemory(parameters: ScryptParameters): number {
  return Math.max(32 * 1024 * 1024, 256 * parameters.n * parameters.r);
}

function decodePart(value: string, label: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0) throw new Error(`Invalid scrypt ${label}`);
  return decoded;
}

function deriveKey(
  secret: string,
  salt: Buffer,
  length: number,
  parameters: ScryptParameters,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      secret,
      salt,
      length,
      {
        N: parameters.n,
        r: parameters.r,
        p: parameters.p,
        maxmem: maxMemory(parameters),
      },
      (error, derivedKey) => {
        if (error !== null) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

export async function hashSecret(
  secret: string,
  parameters: ScryptParameters = defaultParameters,
): Promise<string> {
  if (secret.length < 1) throw new Error("Cannot hash an empty secret");
  assertParameters(parameters);
  const salt = randomBytes(16);
  const derived = await deriveKey(secret, salt, keyLength, parameters);
  return [
    "scrypt",
    version,
    String(parameters.n),
    String(parameters.r),
    String(parameters.p),
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifySecret(secret: string, encoded: string): Promise<boolean> {
  try {
    const parts = encoded.split("$");
    if (parts.length !== 7 || parts[0] !== "scrypt" || parts[1] !== version) {
      return false;
    }
    const n = Number(parts[2]);
    const r = Number(parts[3]);
    const p = Number(parts[4]);
    const parameters = { n, r, p } satisfies ScryptParameters;
    assertParameters(parameters);
    const saltPart = parts[5];
    const hashPart = parts[6];
    if (saltPart === undefined || hashPart === undefined) return false;
    const salt = decodePart(saltPart, "salt");
    const expected = decodePart(hashPart, "hash");
    const actual = await deriveKey(secret, salt, expected.length, parameters);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export const scryptTestParameters: ScryptParameters = {
  n: 16_384,
  r: 8,
  p: 1,
};
