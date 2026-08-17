import { describe, expect, it } from "vitest";

import { buildEip681Uri } from "../../../src/domain/chain/payment-uri.js";

const contractAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const recipientAddress = "0xC46E38c24c706e0cea851317CD8CF05a0Bd7BD05";

describe("buildEip681Uri", () => {
  it("builds a standards-compliant EIP-681 transfer URI", () => {
    expect(
      buildEip681Uri({
        networkChainId: 11155111,
        contractAddress,
        recipientAddress,
        amount: "1000000",
      }),
    ).toBe(
      `ethereum:${contractAddress}@11155111/transfer?address=${recipientAddress}&uint256=1000000`,
    );
  });

  it("checksums lowercase input addresses", () => {
    expect(
      buildEip681Uri({
        networkChainId: 1,
        contractAddress: contractAddress.toLowerCase(),
        recipientAddress: recipientAddress.toLowerCase(),
        amount: "1",
      }),
    ).toBe(
      `ethereum:${contractAddress}@1/transfer?address=${recipientAddress}&uint256=1`,
    );
  });

  it("rejects invalid chain identities", () => {
    for (const networkChainId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        buildEip681Uri({
          networkChainId,
          contractAddress,
          recipientAddress,
          amount: "1",
        }),
      ).toThrow(TypeError);
    }
  });

  it("rejects invalid addresses", () => {
    for (const address of ["not-an-address", "0x123", `${contractAddress}0`]) {
      expect(() =>
        buildEip681Uri({
          networkChainId: 1,
          contractAddress: address,
          recipientAddress,
          amount: "1",
        }),
      ).toThrow(TypeError);
      expect(() =>
        buildEip681Uri({
          networkChainId: 1,
          contractAddress,
          recipientAddress: address,
          amount: "1",
        }),
      ).toThrow(TypeError);
    }
  });

  it("rejects non-canonical or non-positive amounts", () => {
    for (const amount of ["0", "-1", "1.5", "01", "1e3", " 1", "", "0x10"]) {
      expect(() =>
        buildEip681Uri({
          networkChainId: 1,
          contractAddress,
          recipientAddress,
          amount,
        }),
      ).toThrow(TypeError);
    }
  });

  it("accepts maximum uint256-scale integer amounts", () => {
    const maxUint256 = 2n ** 256n - 1n;
    expect(
      buildEip681Uri({
        networkChainId: 1,
        contractAddress,
        recipientAddress,
        amount: maxUint256.toString(10),
      }),
    ).toContain(`uint256=${maxUint256.toString(10)}`);
  });

  it("builds the token-less native form for native assets (ADR 0018)", () => {
    expect(
      buildEip681Uri({
        networkChainId: 137,
        assetType: "native",
        recipientAddress,
        amount: "5000000000000000000",
      }),
    ).toBe(`ethereum:${recipientAddress}@137?value=5000000000000000000`);
  });
});
