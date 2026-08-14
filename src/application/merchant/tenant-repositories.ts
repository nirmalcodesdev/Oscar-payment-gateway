import type { Connection } from "mongoose";

import { ApplicationError } from "../../domain/errors/application-error.js";
import { registerPersistenceModels } from "../../infrastructure/mongodb/models.js";

export class MerchantScopedRepositories {
  readonly #models: ReturnType<typeof registerPersistenceModels>;

  public constructor(connection: Connection) {
    this.#models = registerPersistenceModels(connection);
  }

  public findPayment(merchantId: string, paymentId: string) {
    return this.#models.Payment.findOne({ merchantId, paymentId }).lean();
  }

  public async requirePayment(merchantId: string, paymentId: string) {
    const payment = await this.findPayment(merchantId, paymentId);
    if (payment === null) {
      throw new ApplicationError("NOT_FOUND", "Resource not found", 404);
    }
    return payment;
  }

  public findWalletAddress(merchantId: string, walletAddressId: string) {
    return this.#models.WalletAddress.findOne({ merchantId, walletAddressId }).lean();
  }

  public async requireWalletAddress(merchantId: string, walletAddressId: string) {
    const wallet = await this.findWalletAddress(merchantId, walletAddressId);
    if (wallet === null) {
      throw new ApplicationError("NOT_FOUND", "Resource not found", 404);
    }
    return wallet;
  }

  public findWallet(merchantId: string, xpubId: string) {
    return this.#models.MerchantWallet.findOne({ merchantId, xpubId }).lean();
  }

  public async requireWallet(merchantId: string, xpubId: string) {
    const wallet = await this.findWallet(merchantId, xpubId);
    if (wallet === null) {
      throw new ApplicationError("NOT_FOUND", "Resource not found", 404);
    }
    return wallet;
  }

  public findWebhookDelivery(merchantId: string, deliveryId: string) {
    return this.#models.WebhookDelivery.findOne({ merchantId, deliveryId }).lean();
  }

  public async requireWebhookDelivery(merchantId: string, deliveryId: string) {
    const delivery = await this.findWebhookDelivery(merchantId, deliveryId);
    if (delivery === null) {
      throw new ApplicationError("NOT_FOUND", "Resource not found", 404);
    }
    return delivery;
  }
}
