import { getAddress } from "viem";

import { isPositiveBaseUnitString } from "../money/base-unit.js";

export interface PaymentUriInput {
  readonly networkChainId: number;
  /** EIP-681 scheme: contract-address tokens vs. native no-contract value. */
  readonly assetType?: "erc20" | "native" | undefined;
  readonly contractAddress?: string | undefined;
  readonly recipientAddress: string;
  readonly amount: string;
}

/**
 * Build an EIP-681 payment URI. ERC-20 uses the contract-scoped transfer form;
 * native uses the canonical token-less value form
 * `ethereum:<recipient>@<chainId>?value=<amount>` (ADR 0018).
 */
export function buildEip681Uri(input: PaymentUriInput): string {
  if (!Number.isSafeInteger(input.networkChainId) || input.networkChainId < 1) {
    throw new TypeError("Chain identity is invalid for a payment URI");
  }
  if (!isPositiveBaseUnitString(input.amount)) {
    throw new TypeError("Payment URI amount must be a positive base-unit string");
  }
  let recipientAddress: string;
  try {
    recipientAddress = getAddress(input.recipientAddress);
  } catch {
    throw new TypeError("Payment URI address is invalid");
  }
  if (input.assetType !== "native") {
    if (input.contractAddress === undefined) {
      throw new TypeError("ERC-20 payment URI requires a contract address");
    }
    let contractAddress: string;
    try {
      contractAddress = getAddress(input.contractAddress);
    } catch {
      throw new TypeError("Payment URI address is invalid");
    }
    return `ethereum:${contractAddress}@${input.networkChainId}/transfer?address=${recipientAddress}&uint256=${input.amount}`;
  }
  return `ethereum:${recipientAddress}@${input.networkChainId}?value=${input.amount}`;
}
