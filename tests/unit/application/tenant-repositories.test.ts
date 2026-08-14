import { describe, expect, it, vi } from "vitest";

import { MerchantScopedRepositories } from "../../../src/application/merchant/tenant-repositories.js";

function connectionWithModels() {
  const models = {
    Payment: { findOne: vi.fn(() => ({ lean: vi.fn() })) },
    WalletAddress: { findOne: vi.fn(() => ({ lean: vi.fn() })) },
    MerchantWallet: { findOne: vi.fn(() => ({ lean: vi.fn() })) },
    WebhookDelivery: { findOne: vi.fn(() => ({ lean: vi.fn() })) },
  };
  return {
    connection: { models, model: vi.fn(() => ({})) } as never,
    models,
  };
}

describe("merchant-scoped repositories", () => {
  it("embeds the trusted tenant in every merchant-owned lookup", () => {
    const { connection, models } = connectionWithModels();
    const repositories = new MerchantScopedRepositories(connection);

    void repositories.findPayment("merchant_a", "payment_1");
    void repositories.findWalletAddress("merchant_a", "wallet-address_1");
    void repositories.findWallet("merchant_a", "xpub_1");
    void repositories.findWebhookDelivery("merchant_a", "delivery_1");

    expect(models.Payment.findOne).toHaveBeenCalledWith({
      merchantId: "merchant_a",
      paymentId: "payment_1",
    });
    expect(models.WalletAddress.findOne).toHaveBeenCalledWith({
      merchantId: "merchant_a",
      walletAddressId: "wallet-address_1",
    });
    expect(models.MerchantWallet.findOne).toHaveBeenCalledWith({
      merchantId: "merchant_a",
      xpubId: "xpub_1",
    });
    expect(models.WebhookDelivery.findOne).toHaveBeenCalledWith({
      merchantId: "merchant_a",
      deliveryId: "delivery_1",
    });
  });
});
