import { getAddress } from "viem";

import { isPositiveBaseUnitString } from "../money/base-unit.js";

export interface PaymentUriInput {
  readonly networkChainId: number;
  readonly contractAddress: string;
  readonly recipientAddress: string;
  readonly amount: string;
}

export function buildEip681Uri(input: PaymentUriInput): string {
  if (!Number.isSafeInteger(input.networkChainId) || input.networkChainId < 1) {
    throw new TypeError("Chain identity is invalid for a payment URI");
  }
  let contractAddress: string;
  let recipientAddress: string;
  try {
    contractAddress = getAddress(input.contractAddress);
    recipientAddress = getAddress(input.recipientAddress);
  } catch {
    throw new TypeError("Payment URI address is invalid");
  }
  if (!isPositiveBaseUnitString(input.amount)) {
    throw new TypeError("Payment URI amount must be a positive base-unit string");
  }
  return `ethereum:${contractAddress}@${input.networkChainId}/transfer?address=${recipientAddress}&uint256=${input.amount}`;
}
