const sensitiveFieldPattern =
  /(?:private.?key|private.?extended|xprv|tprv|mnemonic|seed(?:phrase)?|secret.?key|signing.?material|wif)/i;
const hexPrivateKeyPattern = /^(?:0x)?[0-9a-f]{64}$/i;
const pemPrivateKeyPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const wifPattern = /^[5KLc][1-9A-HJ-NP-Za-km-z]{50,51}$/;
const mnemonicWordPattern = /^[a-z]+(?:\s+[a-z]+){11,23}$/i;

function looksLikeSigningMaterial(value: string): boolean {
  return (
    sensitiveFieldPattern.test(value) ||
    hexPrivateKeyPattern.test(value.trim()) ||
    pemPrivateKeyPattern.test(value) ||
    wifPattern.test(value.trim()) ||
    mnemonicWordPattern.test(value.trim())
  );
}

export function containsSigningMaterial(value: unknown, fieldName = ""): boolean {
  if (fieldName.length > 0 && sensitiveFieldPattern.test(fieldName)) return true;
  if (typeof value === "string") return looksLikeSigningMaterial(value);
  if (Array.isArray(value)) {
    return value.some((nested) => containsSigningMaterial(nested));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([key, nested]) =>
      containsSigningMaterial(nested, key),
    );
  }
  return false;
}

export function assertNoSigningMaterial(value: unknown): void {
  if (containsSigningMaterial(value)) {
    throw new Error("Signing material is not accepted");
  }
}
