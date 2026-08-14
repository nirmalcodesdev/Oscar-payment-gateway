import { randomUUID } from "node:crypto";

import { HDKey } from "@scure/bip32";
import mongoose, { type Connection } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  hashSecret,
  verifySecret,
} from "../../src/infrastructure/auth/secret-hasher.js";
import { registerPersistenceModels } from "../../src/infrastructure/mongodb/models.js";

const apiBaseUrl = process.env["PHASE03_API_URL"];
const integrationUri = process.env["MONGODB_INTEGRATION_URI"];
const runIntegration = apiBaseUrl !== undefined && integrationUri !== undefined;
const describeWithServices = runIntegration ? describe : describe.skip;

const testNamespace = randomUUID();
const adminEmail = `phase03-${testNamespace}@example.com`;
const adminPassword = "phase03-admin-password-that-is-long-enough";
const testnetVersions = { public: 0x043587cf, private: 0x04358394 } as const;

interface HttpResult {
  readonly response: Response;
  readonly body: unknown;
}

async function request(path: string, init: RequestInit = {}): Promise<HttpResult> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers,
  });
  const text = await response.text();
  return { response, body: text.length === 0 ? undefined : JSON.parse(text) };
}

function json(
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit {
  return { method, headers, body: JSON.stringify(body) };
}

function testnetXpub(seed = 17): string {
  return HDKey.fromMasterSeed(new Uint8Array(32).fill(seed), testnetVersions)
    .publicExtendedKey;
}

describeWithServices("Phase 03 live merchant security", () => {
  let connection!: Connection;
  let models!: ReturnType<typeof registerPersistenceModels>;
  let adminAccess = "";
  let merchantA: { merchantId: string; apiKey: string; credentialId: string };
  let merchantB: { merchantId: string; apiKey: string; credentialId: string };
  let walletId = "";
  const paymentId = `payment_${testNamespace}`;
  const foreignPaymentId = `payment_${testNamespace}-foreign`;
  const merchantIds: string[] = [];

  beforeAll(async () => {
    if (integrationUri === undefined) {
      throw new Error("MONGODB_INTEGRATION_URI is required");
    }
    connection = mongoose.createConnection(integrationUri, {
      serverSelectionTimeoutMS: 15_000,
      directConnection: true,
      autoIndex: false,
    });
    await connection.asPromise();
    models = registerPersistenceModels(connection);

    await models.AdminIdentity.create({
      adminId: `admin_${testNamespace}`,
      email: adminEmail,
      passwordHash: await hashSecret(adminPassword),
      role: "admin",
      status: "active",
      tokenVersion: 0,
    });
    const storedAdmin = await models.AdminIdentity.findOne({ email: adminEmail })
      .select("+passwordHash")
      .lean();
    if (storedAdmin === null) throw new Error("Admin fixture was not persisted");
    await expect(verifySecret(adminPassword, storedAdmin.passwordHash)).resolves.toBe(
      true,
    );
    const chain = await models.Chain.findOne({ chainId: "ethereum-sepolia" });
    if (chain === null) {
      await models.Chain.create({
        chainId: "ethereum-sepolia",
        name: "Ethereum Sepolia",
        rpcProviders: [
          { providerId: "test-a", url: "https://rpc-a.example" },
          { providerId: "test-b", url: "https://rpc-b.example" },
        ],
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        requiredConfirmations: 2,
        enabled: true,
        version: 0,
      });
    } else if (!chain.enabled) {
      await models.Chain.updateOne(
        { chainId: "ethereum-sepolia" },
        { $set: { enabled: true } },
      );
    }
  });

  afterAll(async () => {
    await models.AdminSession.collection.deleteMany({
      adminId: `admin_${testNamespace}`,
    });
    await models.AdminIdentity.collection.deleteMany({ email: adminEmail });
    await models.Merchant.collection.deleteMany({
      email: { $regex: `^phase03-${testNamespace}` },
    });
    await models.MerchantCredential.collection.deleteMany({
      merchantId: { $in: merchantIds },
    });
    await models.MerchantWallet.collection.deleteMany({
      merchantId: { $in: merchantIds },
    });
    await models.Payment.collection.deleteMany({
      paymentId: { $in: [paymentId, foreignPaymentId] },
    });
    const scopes = merchantIds.map((merchantId) => `merchant_${merchantId}`);
    await models.AuditLog.collection.deleteMany({ scope: { $in: scopes } });
    await models.AuditChainHead.collection.deleteMany({ scope: { $in: scopes } });
    await connection.close();
  });

  it("onboards merchants, authenticates admins, and enforces lifecycle gates", async () => {
    const login = await request(
      "/api/v1/admin/auth/login",
      json("POST", {
        email: adminEmail,
        password: adminPassword,
      }),
    );
    expect(login.response.status).toBe(200);
    const loginBody = login.body as { accessToken: string; refreshToken: string };
    adminAccess = loginBody.accessToken;

    const registeredA = await request(
      "/api/v1/merchants",
      json("POST", { email: `phase03-${testNamespace}-a@example.com` }),
    );
    const registeredB = await request(
      "/api/v1/merchants",
      json("POST", { email: `phase03-${testNamespace}-b@example.com` }),
    );
    expect(registeredA.response.status).toBe(202);
    expect(registeredB.response.status).toBe(202);
    const registeredABody = registeredA.body as { merchantId: string; status: string };
    const registeredBBody = registeredB.body as { merchantId: string; status: string };
    merchantIds.push(registeredABody.merchantId, registeredBBody.merchantId);
    expect(registeredABody.status).toBe("pending_approval");

    for (const registered of [registeredABody, registeredBBody]) {
      const verified = await request(
        `/api/v1/admin/merchants/${registered.merchantId}/email-verification`,
        json("POST", { version: 0 }, { authorization: `Bearer ${adminAccess}` }),
      );
      expect(verified.response.status).toBe(200);
      expect((verified.body as { version: number }).version).toBe(1);
    }

    const approvedA = await request(
      `/api/v1/admin/merchants/${registeredABody.merchantId}/approval`,
      json("POST", { version: 1 }, { authorization: `Bearer ${adminAccess}` }),
    );
    const approvedB = await request(
      `/api/v1/admin/merchants/${registeredBBody.merchantId}/approval`,
      json("POST", { version: 1 }, { authorization: `Bearer ${adminAccess}` }),
    );
    expect(approvedA.response.status).toBe(200);
    expect(approvedB.response.status).toBe(200);
    const approvedABody = approvedA.body as { apiKey: string; credentialId: string };
    const approvedBBody = approvedB.body as { apiKey: string; credentialId: string };
    merchantA = {
      merchantId: registeredABody.merchantId,
      apiKey: approvedABody.apiKey,
      credentialId: approvedABody.credentialId,
    };
    merchantB = {
      merchantId: registeredBBody.merchantId,
      apiKey: approvedBBody.apiKey,
      credentialId: approvedBBody.credentialId,
    };
    const storedCredential = await models.MerchantCredential.findOne({
      credentialId: merchantA.credentialId,
    })
      .select("+secretHash")
      .lean();
    expect(storedCredential?.secretHash).toBeDefined();
    expect(storedCredential?.secretHash).not.toContain(merchantA.apiKey);
    expect(
      JSON.stringify(
        (
          await request(
            `/api/v1/admin/merchants/${merchantA.merchantId}/approval`,
            json("POST", { version: 2 }, { authorization: `Bearer ${adminAccess}` }),
          )
        ).body,
      ),
    ).not.toContain(merchantA.apiKey);

    await models.Payment.collection.insertMany([
      {
        paymentId,
        merchantId: merchantA.merchantId,
        chain: "ethereum-sepolia",
        token: "token_phase03",
        walletAddressId: `wallet-address_${testNamespace}`,
        amount: "1000",
        status: "pending",
        version: 0,
        requiredConfirmations: 2,
        confirmations: 0,
        screeningStatus: "pending",
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        paymentId: foreignPaymentId,
        merchantId: merchantB.merchantId,
        chain: "ethereum-sepolia",
        token: "token_phase03",
        walletAddressId: `wallet-address_${testNamespace}-foreign`,
        amount: "1000",
        status: "pending",
        version: 0,
        requiredConfirmations: 2,
        confirmations: 0,
        screeningStatus: "pending",
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const own = await request(`/api/v1/merchant/payments/${paymentId}`, {
      headers: { "x-oscar-merchant-api-key": merchantA.apiKey },
    });
    const foreign = await request(`/api/v1/merchant/payments/${foreignPaymentId}`, {
      headers: {
        "x-oscar-merchant-api-key": merchantA.apiKey,
        "x-request-id": "same-id",
      },
    });
    const missing = await request(
      `/api/v1/merchant/payments/payment_${testNamespace}-missing`,
      {
        headers: {
          "x-oscar-merchant-api-key": merchantA.apiKey,
          "x-request-id": "same-id",
        },
      },
    );
    expect(own.response.status).toBe(200);
    expect(foreign.response.status).toBe(404);
    expect(missing.response.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);

    const adminOnMerchantRoute = await request(
      `/api/v1/merchant/payments/${paymentId}`,
      {
        headers: { authorization: `Bearer ${adminAccess}` },
      },
    );
    expect(adminOnMerchantRoute.response.status).toBe(401);
  });

  it("protects credentials, webhook configuration, wallet onboarding, and rotations", async () => {
    const foreignCredential = await request(
      `/api/v1/merchant/credentials/${merchantB.credentialId}/revocation`,
      {
        method: "POST",
        headers: {
          "x-oscar-merchant-api-key": merchantA.apiKey,
          "x-request-id": "same-credential-id",
        },
      },
    );
    const missingCredential = await request(
      `/api/v1/merchant/credentials/credential_${testNamespace}-missing/revocation`,
      {
        method: "POST",
        headers: {
          "x-oscar-merchant-api-key": merchantA.apiKey,
          "x-request-id": "same-credential-id",
        },
      },
    );
    expect(foreignCredential.response.status).toBe(404);
    expect(foreignCredential.body).toEqual(missingCredential.body);

    const unsafeWallet = await request(
      "/api/v1/merchant/wallets",
      json(
        "POST",
        {
          chain: "ethereum-sepolia",
          publicExtendedKey: testnetXpub(),
          privateKey: `0x${"ab".repeat(32)}`,
        },
        { "x-oscar-merchant-api-key": merchantA.apiKey },
      ),
    );
    expect(unsafeWallet.response.status).toBe(400);
    expect(JSON.stringify(unsafeWallet.body)).not.toContain("ab".repeat(32));

    const webhook = await request(
      "/api/v1/merchant/webhook",
      json(
        "PUT",
        { version: 2, webhookUrl: "http://user:password@127.0.0.1:8080/callback" },
        { "x-oscar-merchant-api-key": merchantA.apiKey },
      ),
    );
    expect(webhook.response.status).toBe(400);
    const configuredWebhook = await request(
      "/api/v1/merchant/webhook",
      json(
        "PUT",
        { version: 2, webhookUrl: "http://hooks.example.test/callback" },
        { "x-oscar-merchant-api-key": merchantA.apiKey },
      ),
    );
    expect(configuredWebhook.response.status).toBe(200);

    const malformedXpub = `${testnetXpub().slice(0, -1)}1`;
    const invalidWallet = await request(
      "/api/v1/merchant/wallets",
      json(
        "POST",
        { chain: "ethereum-sepolia", publicExtendedKey: malformedXpub },
        { "x-oscar-merchant-api-key": merchantA.apiKey },
      ),
    );
    expect(invalidWallet.response.status).toBe(400);
    expect(JSON.stringify(invalidWallet.body)).not.toContain(malformedXpub);

    const merchantBWallet = await request(
      "/api/v1/merchant/wallets",
      json(
        "POST",
        { chain: "ethereum-sepolia", publicExtendedKey: testnetXpub(20) },
        { "x-oscar-merchant-api-key": merchantB.apiKey },
      ),
    );
    expect(merchantBWallet.response.status).toBe(201);
    const foreignWalletId = (merchantBWallet.body as { xpubId: string }).xpubId;
    const isolationSteps = await Promise.all([
      request("/api/v1/merchant/auth/step-up", {
        method: "POST",
        headers: { "x-oscar-merchant-api-key": merchantA.apiKey },
      }),
      request("/api/v1/merchant/auth/step-up", {
        method: "POST",
        headers: { "x-oscar-merchant-api-key": merchantA.apiKey },
      }),
    ]);
    const firstIsolationStep = isolationSteps[0];
    const secondIsolationStep = isolationSteps[1];
    expect(firstIsolationStep.response.status).toBe(200);
    expect(secondIsolationStep.response.status).toBe(200);
    const foreignWallet = await request(
      `/api/v1/merchant/wallets/${foreignWalletId}`,
      json(
        "PUT",
        { version: 0, chain: "ethereum-sepolia", publicExtendedKey: testnetXpub(21) },
        {
          "x-oscar-merchant-api-key": merchantA.apiKey,
          "x-oscar-wallet-step-up": `Bearer ${(firstIsolationStep.body as { token: string }).token}`,
          "x-request-id": "same-wallet-id",
        },
      ),
    );
    const missingWallet = await request(
      `/api/v1/merchant/wallets/xpub_${testNamespace}-missing`,
      json(
        "PUT",
        { version: 0, chain: "ethereum-sepolia", publicExtendedKey: testnetXpub(22) },
        {
          "x-oscar-merchant-api-key": merchantA.apiKey,
          "x-oscar-wallet-step-up": `Bearer ${(secondIsolationStep.body as { token: string }).token}`,
          "x-request-id": "same-wallet-id",
        },
      ),
    );
    expect(foreignWallet.response.status).toBe(404);
    expect(foreignWallet.body).toEqual(missingWallet.body);

    const wallet = await request(
      "/api/v1/merchant/wallets",
      json(
        "POST",
        { chain: "ethereum-sepolia", publicExtendedKey: testnetXpub() },
        { "x-oscar-merchant-api-key": merchantA.apiKey },
      ),
    );
    expect(wallet.response.status).toBe(201);
    walletId = (wallet.body as { xpubId: string }).xpubId;

    const firstSteps = await Promise.all([
      request("/api/v1/merchant/auth/step-up", {
        method: "POST",
        headers: { "x-oscar-merchant-api-key": merchantA.apiKey },
      }),
      request("/api/v1/merchant/auth/step-up", {
        method: "POST",
        headers: { "x-oscar-merchant-api-key": merchantA.apiKey },
      }),
    ]);
    expect(firstSteps.every((result) => result.response.status === 200)).toBe(true);
    const rotations = await Promise.all(
      firstSteps.map((step) =>
        request(
          `/api/v1/merchant/wallets/${walletId}`,
          json(
            "PUT",
            {
              version: 0,
              chain: "ethereum-sepolia",
              publicExtendedKey: testnetXpub(19),
            },
            {
              "x-oscar-merchant-api-key": merchantA.apiKey,
              "x-oscar-wallet-step-up": `Bearer ${(step.body as { token: string }).token}`,
            },
          ),
        ),
      ),
    );
    expect(rotations.filter((result) => result.response.status === 200)).toHaveLength(
      1,
    );
    expect(
      rotations.some(
        (result) => result.response.status === 404 || result.response.status === 409,
      ),
    ).toBe(true);
    expect(
      await models.MerchantWallet.countDocuments({
        merchantId: merchantA.merchantId,
        status: "active",
      }),
    ).toBe(1);
    expect((await models.Payment.findOne({ paymentId }).lean())?.walletAddressId).toBe(
      `wallet-address_${testNamespace}`,
    );

    const credentialRotations = await Promise.all([
      request("/api/v1/merchant/credentials/rotate", {
        method: "POST",
        headers: { "x-oscar-merchant-api-key": merchantA.apiKey },
      }),
      request("/api/v1/merchant/credentials/rotate", {
        method: "POST",
        headers: { "x-oscar-merchant-api-key": merchantA.apiKey },
      }),
    ]);
    const successfulRotation = credentialRotations.find(
      (result) => result.response.status === 200,
    );
    expect(successfulRotation).toBeDefined();
    expect(
      credentialRotations.filter((result) => result.response.status === 200),
    ).toHaveLength(1);
    expect(
      credentialRotations.some(
        (result) => result.response.status === 401 || result.response.status === 409,
      ),
    ).toBe(true);
    expect(
      await models.MerchantCredential.countDocuments({
        merchantId: merchantA.merchantId,
        status: "active",
      }),
    ).toBe(1);
    if (successfulRotation === undefined) {
      throw new Error("Credential rotation did not produce a replacement");
    }
    const replacement = successfulRotation.body as {
      apiKey: string;
      credentialId: string;
    };
    await expect(
      request(`/api/v1/merchant/payments/${paymentId}`, {
        headers: { "x-oscar-merchant-api-key": merchantA.apiKey },
      }).then((result) => result.response.status),
    ).resolves.toBe(401);
    merchantA = {
      ...merchantA,
      apiKey: replacement.apiKey,
      credentialId: replacement.credentialId,
    };

    const extraKey = `osk_test_${"c".repeat(18)}_${"d".repeat(43)}`;
    await models.MerchantCredential.create({
      credentialId: `credential_${testNamespace}-extra`,
      merchantId: merchantA.merchantId,
      prefix: `osk_test_${"c".repeat(18)}`,
      secretHash: await hashSecret(extraKey),
      scopes: ["merchant:read"],
      status: "active",
    });
    const revoke = await request(
      `/api/v1/merchant/credentials/credential_${testNamespace}-extra/revocation`,
      { method: "POST", headers: { "x-oscar-merchant-api-key": merchantA.apiKey } },
    );
    expect(revoke.response.status).toBe(204);
    expect(
      (
        await request(`/api/v1/merchant/payments/${paymentId}`, {
          headers: { "x-oscar-merchant-api-key": extraKey },
        })
      ).response.status,
    ).toBe(401);

    const expiredKey = `osk_test_${"e".repeat(18)}_${"f".repeat(43)}`;
    await models.MerchantCredential.create({
      credentialId: `credential_${testNamespace}-expired`,
      merchantId: merchantA.merchantId,
      prefix: `osk_test_${"e".repeat(18)}`,
      secretHash: await hashSecret(expiredKey),
      scopes: ["merchant:read"],
      status: "active",
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(
      (
        await request(`/api/v1/merchant/payments/${paymentId}`, {
          headers: { "x-oscar-merchant-api-key": expiredKey },
        })
      ).response.status,
    ).toBe(401);
  });

  it("handles refresh reuse, logout, suspension, and concurrent approval safely", async () => {
    const firstLogin = await request(
      "/api/v1/admin/auth/login",
      json("POST", {
        email: adminEmail,
        password: adminPassword,
      }),
    );
    const firstTokens = firstLogin.body as {
      accessToken: string;
      refreshToken: string;
    };
    const rotated = await request(
      "/api/v1/admin/auth/refresh",
      json("POST", {
        refreshToken: firstTokens.refreshToken,
      }),
    );
    expect(rotated.response.status).toBe(200);
    const rotatedTokens = rotated.body as { accessToken: string; refreshToken: string };
    expect(
      (
        await request(
          "/api/v1/admin/auth/refresh",
          json("POST", {
            refreshToken: firstTokens.refreshToken,
          }),
        )
      ).response.status,
    ).toBe(401);
    expect(
      (
        await request(
          `/api/v1/admin/merchants/${merchantA.merchantId}/approval`,
          json(
            "POST",
            { version: 2 },
            { authorization: `Bearer ${rotatedTokens.accessToken}` },
          ),
        )
      ).response.status,
    ).toBe(401);

    const logoutLogin = await request(
      "/api/v1/admin/auth/login",
      json("POST", {
        email: adminEmail,
        password: adminPassword,
      }),
    );
    const logoutTokens = logoutLogin.body as { accessToken: string };
    expect(
      (
        await request("/api/v1/admin/auth/logout", {
          method: "POST",
          headers: { authorization: `Bearer ${logoutTokens.accessToken}` },
        })
      ).response.status,
    ).toBe(204);
    expect(
      (
        await request("/api/v1/admin/auth/logout", {
          method: "POST",
          headers: { authorization: `Bearer ${logoutTokens.accessToken}` },
        })
      ).response.status,
    ).toBe(401);

    const currentLogin = await request(
      "/api/v1/admin/auth/login",
      json("POST", {
        email: adminEmail,
        password: adminPassword,
      }),
    );
    adminAccess = (currentLogin.body as { accessToken: string }).accessToken;

    const suspended = await request(
      `/api/v1/admin/merchants/${merchantB.merchantId}/status`,
      json(
        "PATCH",
        { version: 2, status: "suspended" },
        { authorization: `Bearer ${adminAccess}` },
      ),
    );
    expect(suspended.response.status).toBe(200);
    expect(
      (
        await request(`/api/v1/merchant/payments/${paymentId}`, {
          headers: { "x-oscar-merchant-api-key": merchantB.apiKey },
        })
      ).response.status,
    ).toBe(401);

    const concurrentEmail = `phase03-${testNamespace}-concurrent@example.com`;
    const registration = await request(
      "/api/v1/merchants",
      json("POST", { email: concurrentEmail }),
    );
    const concurrentMerchantId = (registration.body as { merchantId: string })
      .merchantId;
    merchantIds.push(concurrentMerchantId);
    await request(
      `/api/v1/admin/merchants/${concurrentMerchantId}/email-verification`,
      json("POST", { version: 0 }, { authorization: `Bearer ${adminAccess}` }),
    );
    const approvals = await Promise.all([
      request(
        `/api/v1/admin/merchants/${concurrentMerchantId}/approval`,
        json("POST", { version: 1 }, { authorization: `Bearer ${adminAccess}` }),
      ),
      request(
        `/api/v1/admin/merchants/${concurrentMerchantId}/approval`,
        json("POST", { version: 1 }, { authorization: `Bearer ${adminAccess}` }),
      ),
    ]);
    expect(approvals.filter((result) => result.response.status === 200)).toHaveLength(
      1,
    );
    expect(
      await models.MerchantCredential.countDocuments({
        merchantId: concurrentMerchantId,
      }),
    ).toBe(1);
    const successfulApproval = approvals.find(
      (result) => result.response.status === 200,
    );
    if (successfulApproval === undefined) {
      throw new Error("Concurrent approval did not produce a credential");
    }
    const rejected = await request(
      `/api/v1/admin/merchants/${concurrentMerchantId}/status`,
      json(
        "PATCH",
        { version: 2, status: "rejected" },
        { authorization: `Bearer ${adminAccess}` },
      ),
    );
    expect(rejected.response.status).toBe(200);
    expect(
      (
        await request(`/api/v1/merchant/payments/${paymentId}`, {
          headers: {
            "x-oscar-merchant-api-key": (successfulApproval.body as { apiKey: string })
              .apiKey,
          },
        })
      ).response.status,
    ).toBe(401);
  });
});
