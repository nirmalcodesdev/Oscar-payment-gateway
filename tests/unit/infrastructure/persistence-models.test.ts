import mongoose from "mongoose";
import { afterAll, describe, expect, it } from "vitest";

import {
  modelDefinitions,
  paymentStatuses,
  registerPersistenceModels,
} from "../../../src/infrastructure/mongodb/models.js";

const connection = mongoose.createConnection();
const models = registerPersistenceModels(connection);

const validPayment = {
  paymentId: "payment_001",
  merchantId: "merchant_001",
  chain: "ethereum-mainnet",
  token: "usdc-mainnet",
  walletAddressId: "wallet_address_001",
  amount: "1000000",
  status: "pending",
  version: 0,
  requiredConfirmations: 12,
  tokenVerificationPolicy: "event_only",
  confirmations: 0,
  screeningStatus: "pending",
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
};

function namedIndexes(schema: mongoose.Schema): Map<string, mongoose.IndexOptions> {
  return new Map(
    schema.indexes().map(([, options]) => [String(options.name), options]),
  );
}

afterAll(async () => {
  await connection.close();
});

describe("persistence model contracts", () => {
  it("registers every Phase 02 entity with strict-throw schemas", () => {
    expect(Object.keys(modelDefinitions)).toEqual(
      expect.arrayContaining([
        "Merchant",
        "MerchantCredential",
        "MerchantWallet",
        "WalletAddress",
        "Payment",
        "Chain",
        "Token",
        "OnChainEvent",
        "ChainCursor",
        "ObservedBlock",
        "ReorgRecord",
        "AuditLog",
        "IdempotencyKey",
        "ComplianceScreening",
        "WebhookDelivery",
        "ConsumedHmacNonce",
        "AdminIdentity",
        "AdminSession",
        "ReconciliationAnnotation",
      ]),
    );

    for (const schema of Object.values(modelDefinitions)) {
      expect(schema.get("strict")).toBe("throw");
      expect(schema.get("strictQuery")).toBe("throw");
    }
  });

  it("rejects unknown fields and signing material", async () => {
    expect(
      () => new models.Payment({ ...validPayment, privateKey: "0xsecret" }),
    ).toThrow();

    const privateExtendedKey = new models.MerchantWallet({
      xpubId: "xpub_001",
      merchantId: "merchant_001",
      chain: "ethereum-mainnet",
      publicExtendedKey: `xprv${"A".repeat(64)}`,
      fingerprint: "deadbeef",
      nextDerivationIndex: 0,
      status: "active",
      version: 0,
    });
    await expect(privateExtendedKey.validate()).rejects.toThrow();
  });

  it.each(["1.5", "01", "-1", "1e6", "", 1])(
    "rejects invalid payment amount %j",
    async (amount) => {
      await expect(
        new models.Payment({ ...validPayment, amount }).validate(),
      ).rejects.toThrow();
    },
  );

  it("accepts only the specified payment and screening states", async () => {
    expect(paymentStatuses).toEqual([
      "pending",
      "matched",
      "confirming",
      "confirmed",
      "expired",
      "failed",
    ]);
    await expect(new models.Payment(validPayment).validate()).resolves.toBeUndefined();
    await expect(
      new models.Payment({ ...validPayment, status: "refunded" }).validate(),
    ).rejects.toThrow();
    await expect(
      new models.Payment({ ...validPayment, screeningStatus: "approved" }).validate(),
    ).rejects.toThrow();
  });

  it("marks payment destination/finality and event identity as immutable", () => {
    for (const path of [
      "merchantId",
      "chain",
      "token",
      "walletAddressId",
      "amount",
      "expiresAt",
      "requiredConfirmations",
      "tokenVerificationPolicy",
    ]) {
      expect(modelDefinitions.Payment.path(path).options["immutable"]).toBe(true);
    }
    // `token` is resolved during interpretation (ADR 0010), not captured at
    // ingest, so it is deliberately mutable; only raw capture fields stay
    // immutable.
    for (const path of [
      "eventId",
      "chain",
      "contractAddress",
      "transactionHash",
      "logIndex",
      "blockNumber",
      "blockHash",
      "amount",
      "rawEvent",
      "ingestedAt",
    ]) {
      expect(modelDefinitions.OnChainEvent.path(path).options["immutable"]).toBe(true);
    }
    for (const path of [
      "address",
      "normalizedAddress",
      "merchantId",
      "xpubId",
      "derivationIndex",
    ]) {
      expect(modelDefinitions.WalletAddress.path(path).options["immutable"]).toBe(true);
    }
  });

  it("requires verified registry identity, policy, and allocation guards", async () => {
    const chain = new models.Chain({
      chainId: "ethereum-sepolia",
      networkFamily: "evm",
      networkChainId: 11155111,
      name: "Ethereum Sepolia",
      rpcProviders: [
        { providerId: "rpc-a", operatorId: "operator-a" },
        { providerId: "rpc-b", operatorId: "operator-b" },
      ],
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      requiredConfirmations: 2,
      enabled: false,
      version: 0,
      allocationSequence: 0,
    });
    await expect(chain.validate()).resolves.toBeUndefined();
    expect(modelDefinitions.Chain.path("networkChainId").options["immutable"]).toBe(
      true,
    );

    const token = new models.Token({
      tokenId: "usdc-sepolia",
      chain: "ethereum-sepolia",
      symbol: "USDC",
      contractAddress: "0x1111111111111111111111111111111111111111",
      normalizedContractAddress: "0x1111111111111111111111111111111111111111",
      decimals: 6,
      minAmount: "1",
      maxAmount: "1000000",
      verificationPolicy: "balance_delta_required",
      enabled: false,
      verificationStatus: "unverified",
      version: 0,
      allocationSequence: 0,
    });
    await expect(token.validate()).resolves.toBeUndefined();
    await expect(
      new models.Token({
        ...token.toObject(),
        verificationPolicy: "trust_event_without_review",
      }).validate(),
    ).rejects.toThrow();
  });

  it("declares every correctness-critical unique and query index", () => {
    const payment = namedIndexes(modelDefinitions.Payment);
    const event = namedIndexes(modelDefinitions.OnChainEvent);
    const wallet = namedIndexes(modelDefinitions.WalletAddress);
    const idempotency = namedIndexes(modelDefinitions.IdempotencyKey);

    expect(payment.has("ix_payment_chain_token_status")).toBe(true);
    expect(payment.get("uq_payment_wallet_address")?.unique).toBe(true);
    expect(event.get("uq_on_chain_event_id")?.unique).toBe(true);
    expect(event.get("uq_event_payment_claim")?.unique).toBe(true);
    expect(event.get("uq_event_payment_claim")?.partialFilterExpression).toBeDefined();
    expect(event.has("ix_event_chain_contract_block")).toBe(true);
    expect(event.has("ix_event_chain_normalized_contract_block")).toBe(true);
    expect(wallet.get("uq_xpub_derivation_index")?.unique).toBe(true);
    expect(
      wallet.get("uq_wallet_assigned_payment")?.partialFilterExpression,
    ).toBeDefined();
    expect(idempotency.get("uq_idempotency_scope_key")?.unique).toBe(true);
  });

  it("declares explicit model references for ownership and financial history", () => {
    expect(modelDefinitions.Payment.path("merchantId").options["ref"]).toBe("Merchant");
    expect(modelDefinitions.Payment.path("walletAddressId").options["ref"]).toBe(
      "WalletAddress",
    );
    expect(modelDefinitions.OnChainEvent.path("matchedPaymentId").options["ref"]).toBe(
      "Payment",
    );
    expect(modelDefinitions.WalletAddress.path("xpubId").options["ref"]).toBe(
      "MerchantWallet",
    );
    expect(modelDefinitions.WebhookDelivery.path("merchantId").options["ref"]).toBe(
      "Merchant",
    );
  });

  it("limits TTL deletion to provisional records", () => {
    const ttlCollections = Object.values(modelDefinitions)
      .flatMap((schema) => {
        const collectionName = schema.get("collection");
        if (typeof collectionName !== "string") {
          throw new Error("Schema collection name is required");
        }
        return schema
          .indexes()
          .filter(([, options]) => options.expireAfterSeconds !== undefined)
          .map(() => collectionName);
      })
      .sort();

    expect(ttlCollections).toEqual([
      "admin_sessions",
      "compliance_screenings",
      "consumed_hmac_nonces",
      "idempotency_keys",
      "webhook_deliveries",
    ]);
    expect(ttlCollections).not.toEqual(
      expect.arrayContaining([
        "payments",
        "on_chain_events",
        "reorg_records",
        "audit_logs",
        "wallet_addresses",
      ]),
    );
  });

  it("requires conditional optimistic version increments for every payment update", async () => {
    await expect(
      models.Payment.updateOne(
        { paymentId: "payment_001", version: 0 },
        { $set: { status: "matched" } },
      ),
    ).rejects.toThrow("increment version exactly once");
    await expect(
      models.Payment.updateOne(
        { paymentId: "payment_001" },
        { $set: { status: "matched" }, $inc: { version: 1 } },
      ),
    ).rejects.toThrow("previously read version");
  });

  it("protects sensitive values from default projections", () => {
    expect(
      modelDefinitions.MerchantCredential.path("secretHash").options["select"],
    ).toBe(false);
    expect(
      modelDefinitions.MerchantWallet.path("publicExtendedKey").options["select"],
    ).toBe(false);
    expect(
      modelDefinitions.ComplianceScreening.path("rawResponse").options["select"],
    ).toBe(false);
    expect(
      modelDefinitions.AdminSession.path("refreshTokenHash").options["select"],
    ).toBe(false);
  });
});
