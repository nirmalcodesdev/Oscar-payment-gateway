import { createHash, randomUUID } from "node:crypto";

import { HDKey } from "@scure/bip32";
import mongoose, { type Connection } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress } from "viem";

import { generateMerchantApiKey } from "../../src/infrastructure/auth/merchant-api-key.js";
import { hashSecret } from "../../src/infrastructure/auth/secret-hasher.js";
import { verifyAuditChain } from "../../src/infrastructure/mongodb/audit-service.js";
import { registerPersistenceModels } from "../../src/infrastructure/mongodb/models.js";

const apiBaseUrl = process.env["PHASE03_API_URL"];
const integrationUri = process.env["MONGODB_INTEGRATION_URI"];
const runIntegration = apiBaseUrl !== undefined && integrationUri !== undefined;
const describeWithServices = runIntegration ? describe : describe.skip;

const namespace = randomUUID();
const adminEmail = `phase05-${namespace}@example.com`;
const adminPassword = "phase05-admin-password-that-is-long-enough";
const chainId = "ethereum-sepolia";
const tokenId = `phase05-usdc-${namespace}`;
const contractSeed = createHash("sha256").update(namespace).digest("hex");
const contractAddress = `0x${contractSeed.slice(0, 40)}`;
const checksummedContractAddress = getAddress(contractAddress);
const testnetVersions = { public: 0x043587cf, private: 0x04358394 } as const;
const cleanSeedAddress0 = "0xC46E38c24c706e0cea851317CD8CF05a0Bd7BD05";
const cleanSeedAddress1 = "0x8f2d8D9D408E32E735a668f773945ff0237f2Ab1";
const sanctionedSeedAddress0 = "0xD78523784b3A8e5c21D026eE7Fe405C39D1542ac";

function testnetXpub(seed: number): string {
  return HDKey.fromMasterSeed(new Uint8Array(32).fill(seed), testnetVersions)
    .publicExtendedKey;
}

interface HttpResult {
  readonly response: Response;
  readonly body: unknown;
}

async function request(path: string, init: RequestInit = {}): Promise<HttpResult> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });
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

function merchantHeaders(apiKey: string, extra: Record<string, string> = {}) {
  return { "x-oscar-merchant-api-key": apiKey, ...extra };
}

interface MerchantFixture {
  readonly merchantId: string;
  readonly apiKey: string;
  readonly credentialId: string;
}

describeWithServices("Phase 05 live payment intent creation", () => {
  let connection!: Connection;
  let models!: ReturnType<typeof registerPersistenceModels>;
  let adminAccess = "";
  let merchantA!: MerchantFixture;
  let merchantB!: MerchantFixture;
  let merchantC!: MerchantFixture;
  let merchantD!: MerchantFixture;
  let merchantE!: MerchantFixture;
  let walletA = "";
  let walletB = "";
  let createdChainFixture = false;
  const adminId = `admin_phase05_${namespace}`;
  const merchantIds: string[] = [];
  const paymentIds: string[] = [];
  const tokenIds: string[] = [];

  async function onboardMerchant(emailLabel: string): Promise<MerchantFixture> {
    const registered = await request(
      "/api/v1/merchants",
      json("POST", { email: `phase05-${emailLabel}-${namespace}@example.com` }),
    );
    expect(registered.response.status).toBe(202);
    const merchantId = (registered.body as { merchantId: string }).merchantId;
    merchantIds.push(merchantId);
    const verified = await request(
      `/api/v1/admin/merchants/${merchantId}/email-verification`,
      json("POST", { version: 0 }, { authorization: `Bearer ${adminAccess}` }),
    );
    expect(verified.response.status).toBe(200);
    const approved = await request(
      `/api/v1/admin/merchants/${merchantId}/approval`,
      json("POST", { version: 1 }, { authorization: `Bearer ${adminAccess}` }),
    );
    expect(approved.response.status).toBe(200);
    const body = approved.body as { apiKey: string; credentialId: string };
    return { merchantId, apiKey: body.apiKey, credentialId: body.credentialId };
  }

  async function registerWallet(apiKey: string, seed: number): Promise<string> {
    const registered = await request("/api/v1/merchant/wallets", {
      method: "POST",
      headers: merchantHeaders(apiKey),
      body: JSON.stringify({ chain: chainId, publicExtendedKey: testnetXpub(seed) }),
    });
    expect(registered.response.status, JSON.stringify(registered.body)).toBe(201);
    return (registered.body as { xpubId: string }).xpubId;
  }

  beforeAll(async () => {
    if (integrationUri === undefined) throw new Error("Integration URI is required");
    connection = mongoose.createConnection(integrationUri, {
      serverSelectionTimeoutMS: 15_000,
      directConnection: true,
      autoIndex: false,
    });
    await connection.asPromise();
    models = registerPersistenceModels(connection);

    await models.AdminIdentity.create({
      adminId,
      email: adminEmail,
      passwordHash: await hashSecret(adminPassword),
      role: "admin",
      status: "active",
      tokenVersion: 0,
    });
    const login = await request(
      "/api/v1/admin/auth/login",
      json("POST", { email: adminEmail, password: adminPassword }),
    );
    expect(login.response.status).toBe(200);
    adminAccess = (login.body as { accessToken: string }).accessToken;

    // Hermetic provider state (ADR 0017): the shared API process may hold a
    // managed list ingest from phase08 (or a prior run) in its 30-second
    // in-memory cache. Retire any active managed list and reset the cache so
    // every screening assertion in this suite observes the static-list
    // fallback deterministically, independent of file ordering or run timing.
    const reset = await request("/api/v1/admin/compliance/sanctions-list/active", {
      method: "DELETE",
      headers: { authorization: `Bearer ${adminAccess}` },
    });
    expect(reset.response.status, JSON.stringify(reset.body)).toBe(200);

    // Tolerant of a leftover `USDC` token from an interrupted prior run (or
    // phase06's fixture): the unique `uq_chain_token_symbol` index would
    // otherwise reject token creation with a 409. Remove only this suite's
    // own token id and any surviving USDC entry on this chain, then re-create.
    await models.Token.collection.deleteMany({
      chain: chainId,
      $or: [{ tokenId }, { symbol: "USDC" }],
    });

    const chain = await models.Chain.findOne({ chainId });
    const chainFixture = {
      networkFamily: "evm",
      networkChainId: 11155111,
      name: "Ethereum Sepolia",
      rpcProviders: [
        { providerId: "local-rpc-a", operatorId: "local-operator-a" },
        { providerId: "local-rpc-b", operatorId: "local-operator-b" },
      ],
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      requiredConfirmations: 2,
      enabled: true,
      allocationSequence: 0,
      verifiedAt: new Date(),
    };
    if (chain === null) {
      createdChainFixture = true;
      await models.Chain.create({ chainId, version: 0, ...chainFixture });
    } else {
      await models.Chain.collection.updateOne(
        { chainId },
        { $set: { ...chainFixture } },
      );
    }

    const created = await request(
      "/api/v1/admin/tokens",
      json(
        "POST",
        {
          tokenId,
          chain: chainId,
          symbol: "USDC",
          contractAddress,
          decimals: 6,
          minAmount: "100",
          maxAmount: "1000000000000",
          verificationPolicy: "event_only",
        },
        { authorization: `Bearer ${adminAccess}` },
      ),
    );
    expect(created.response.status, JSON.stringify(created.body)).toBe(201);
    tokenIds.push(tokenId);
    const activated = await request(
      `/api/v1/admin/tokens/${tokenId}/activation`,
      json("POST", { expectedVersion: 0 }, { authorization: `Bearer ${adminAccess}` }),
    );
    expect(activated.response.status, JSON.stringify(activated.body)).toBe(200);

    merchantA = await onboardMerchant("a");
    merchantB = await onboardMerchant("b");
    merchantC = await onboardMerchant("c");
    merchantD = await onboardMerchant("d");
    merchantE = await onboardMerchant("e");
    walletA = await registerWallet(merchantA.apiKey, 6);
    walletB = await registerWallet(merchantB.apiKey, 7);
    await registerWallet(merchantC.apiKey, 5);
  });

  afterAll(async () => {
    await models.Payment.collection.deleteMany({ paymentId: { $in: paymentIds } });
    await models.WalletAddress.collection.deleteMany({
      merchantId: { $in: merchantIds },
    });
    await models.IdempotencyKey.collection.deleteMany({
      scope: { $in: merchantIds.map((id) => `payment_create:${id}`) },
    });
    await models.ComplianceScreening.collection.deleteMany({
      chain: chainId,
      checkedAt: { $gte: new Date(Date.now() - 3_600_000) },
    });
    await models.Token.collection.deleteMany({ tokenId: { $in: tokenIds } });
    await models.MerchantWallet.collection.deleteMany({
      merchantId: { $in: merchantIds },
    });
    await models.MerchantCredential.collection.deleteMany({
      merchantId: { $in: merchantIds },
    });
    await models.Merchant.collection.deleteMany({ merchantId: { $in: merchantIds } });
    await models.AdminSession.collection.deleteMany({ adminId });
    await models.AdminIdentity.collection.deleteMany({ adminId });
    const scopes = merchantIds.map((merchantId) => `merchant_${merchantId}`);
    await models.AuditLog.collection.deleteMany({ scope: { $in: scopes } });
    await models.AuditChainHead.collection.deleteMany({ scope: { $in: scopes } });
    if (createdChainFixture) {
      await models.Chain.collection.deleteOne({ chainId });
    }
    await connection.close();
  });

  function trackPayment(body: unknown): string {
    const paymentId = (body as { paymentId: string }).paymentId;
    paymentIds.push(paymentId);
    return paymentId;
  }

  it("creates payments with unique derived addresses and durable audit", async () => {
    const before = new Date();
    const created = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantA.apiKey),
      body: JSON.stringify({ chain: chainId, token: tokenId, amount: "1000" }),
    });
    expect(created.response.status, JSON.stringify(created.body)).toBe(201);
    const body = created.body as Record<string, unknown>;
    const paymentId = trackPayment(body);
    expect(paymentId).toMatch(/^payment_/);
    expect(body).toMatchObject({
      status: "pending",
      chain: chainId,
      token: tokenId,
      amount: "1000",
      recipientAddress: cleanSeedAddress0,
      requiredConfirmations: 2,
      screeningStatus: "clear",
    });
    expect(body["qrCodeData"]).toBe(
      `ethereum:${checksummedContractAddress}@11155111/transfer?address=${cleanSeedAddress0}&uint256=1000`,
    );
    const expiresAt = new Date(body["expiresAt"] as string);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before.getTime() + 299_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(before.getTime() + 901_000);
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      "xpub",
      "tpub",
      "derivationIndex",
      "walletAddressId",
      "mongodb",
      "local-rpc",
      "http://",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const payment = await models.Payment.findOne({ paymentId }).lean();
    expect(payment).toMatchObject({
      merchantId: merchantA.merchantId,
      status: "pending",
      version: 0,
      confirmations: 0,
      screeningStatus: "clear",
      tokenVerificationPolicy: "event_only",
    });
    const walletAddress = await models.WalletAddress.findOne({
      walletAddressId: payment?.walletAddressId,
    }).lean();
    expect(walletAddress).toMatchObject({
      merchantId: merchantA.merchantId,
      chain: chainId,
      xpubId: walletA,
      derivationIndex: 0,
      assignedPaymentId: paymentId,
      status: "assigned",
      address: cleanSeedAddress0,
    });
    const screening = await models.ComplianceScreening.findOne({
      normalizedAddress: cleanSeedAddress0.toLowerCase(),
    }).lean();
    expect(screening).toMatchObject({
      sanctioned: false,
      riskLevel: "clear",
      provider: "static-list",
      listVersion: "local-test-v1",
    });

    const second = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantA.apiKey),
      body: JSON.stringify({ chain: chainId, token: tokenId, amount: "2000" }),
    });
    expect(second.response.status, JSON.stringify(second.body)).toBe(201);
    const secondBody = second.body as Record<string, unknown>;
    trackPayment(secondBody);
    expect(secondBody["recipientAddress"]).toBe(cleanSeedAddress1);
    const secondAddress = await models.WalletAddress.findOne({
      assignedPaymentId: secondBody["paymentId"],
    }).lean();
    expect(secondAddress?.derivationIndex).toBe(1);
    expect(secondAddress?.xpubId).toBe(walletA);

    const audit = await models.AuditLog.findOne({
      entityType: "Payment",
      entityId: paymentId,
      action: "payment_created",
    }).lean();
    expect(audit).toMatchObject({
      scope: `merchant_${merchantA.merchantId}`,
      actorType: "merchant",
      actorId: merchantA.merchantId,
    });
    expect(JSON.stringify(audit)).not.toContain("tpub");
    expect(JSON.stringify(audit)).not.toContain("derivationIndex");
    const chainVerification = await verifyAuditChain(
      connection,
      `merchant_${merchantA.merchantId}`,
    );
    expect(chainVerification.valid).toBe(true);
  });

  it("rejects amounts outside token bounds and non-canonical formats", async () => {
    const amounts = [
      "99",
      "1000000000001",
      "0",
      "-5",
      "+5",
      "1.5",
      "0100",
      "1e3",
      " 100",
      "100 ",
      "0x64",
      "",
    ];
    for (const amount of amounts) {
      const rejected = await request("/api/v1/payments", {
        method: "POST",
        headers: merchantHeaders(merchantA.apiKey),
        body: JSON.stringify({ chain: chainId, token: tokenId, amount }),
      });
      expect(rejected.response.status, amount).toBe(400);
      expect((rejected.body as { error: { code: string } }).error.code).toBe(
        "VALIDATION_ERROR",
      );
    }
    const numericAmount = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantA.apiKey),
      body: JSON.stringify({ chain: chainId, token: tokenId, amount: 1000 }),
    });
    expect(numericAmount.response.status).toBe(400);
    const unknownField = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantA.apiKey),
      body: JSON.stringify({
        chain: chainId,
        token: tokenId,
        amount: "1000",
        merchantId: merchantB.merchantId,
      }),
    });
    expect(unknownField.response.status).toBe(400);
    const maximumInteger = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantA.apiKey),
      body: JSON.stringify({
        chain: chainId,
        token: tokenId,
        amount: "9".repeat(78),
      }),
    });
    expect(maximumInteger.response.status).toBe(400);
  });

  it("clamps expiry server-side and applies the configured default", async () => {
    const cases = [
      { expiresInSec: 10, expectedSec: 300 },
      { expiresInSec: 86400, expectedSec: 7200 },
      { expiresInSec: undefined, expectedSec: 900 },
    ];
    for (const testCase of cases) {
      const created = await request("/api/v1/payments", {
        method: "POST",
        headers: merchantHeaders(merchantA.apiKey),
        body: JSON.stringify({
          chain: chainId,
          token: tokenId,
          amount: "1000",
          ...(testCase.expiresInSec === undefined
            ? {}
            : { expiresInSec: testCase.expiresInSec }),
        }),
      });
      expect(created.response.status, JSON.stringify(created.body)).toBe(201);
      const body = created.body as {
        paymentId: string;
        expiresAt: string;
        createdAt: string;
      };
      trackPayment(body);
      const deltaSec =
        (new Date(body.expiresAt).getTime() - new Date(body.createdAt).getTime()) /
        1000;
      expect(deltaSec).toBeGreaterThanOrEqual(testCase.expectedSec - 1);
      expect(deltaSec).toBeLessThanOrEqual(testCase.expectedSec + 1);
    }
  });

  it("honors idempotency keys exactly once and conflicts on reuse", async () => {
    const key = `idem-${namespace}-aaaa1111`;
    const body = { chain: chainId, token: tokenId, amount: "1500" };
    const first = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantA.apiKey, { "idempotency-key": key }),
      body: JSON.stringify(body),
    });
    expect(first.response.status, JSON.stringify(first.body)).toBe(201);
    const firstBody = first.body as Record<string, unknown>;
    trackPayment(firstBody);

    const replay = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantA.apiKey, { "idempotency-key": key }),
      body: JSON.stringify(body),
    });
    expect(replay.response.status).toBe(201);
    expect(replay.body).toEqual(firstBody);
    await expect(
      models.Payment.countDocuments({ paymentId: firstBody["paymentId"] }),
    ).resolves.toBe(1);
    const record = await models.IdempotencyKey.findOne({
      scope: `payment_create:${merchantA.merchantId}`,
      key,
    }).lean();
    expect(record?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const conflict = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantA.apiKey, { "idempotency-key": key }),
      body: JSON.stringify({ ...body, amount: "1600" }),
    });
    expect(conflict.response.status).toBe(409);
    expect((conflict.body as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_CONFLICT",
    );

    for (const badKey of ["short", "x".repeat(256), "invalid key!12345678"]) {
      const malformed = await request("/api/v1/payments", {
        method: "POST",
        headers: merchantHeaders(merchantA.apiKey, { "idempotency-key": badKey }),
        body: JSON.stringify(body),
      });
      expect(malformed.response.status).toBe(400);
    }

    const concurrentKey = `idem-${namespace}-bbbb2222`;
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () =>
        request("/api/v1/payments", {
          method: "POST",
          headers: merchantHeaders(merchantA.apiKey, {
            "idempotency-key": concurrentKey,
          }),
          body: JSON.stringify({ ...body, amount: "1700" }),
        }),
      ),
    );
    const successes = attempts.filter((attempt) => attempt.response.status === 201);
    expect(successes.length).toBeGreaterThanOrEqual(1);
    const uniquePaymentIds = new Set(
      successes.map((success) => (success.body as { paymentId: string }).paymentId),
    );
    expect(uniquePaymentIds.size).toBe(1);
    const settled = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantA.apiKey, { "idempotency-key": concurrentKey }),
      body: JSON.stringify({ ...body, amount: "1700" }),
    });
    expect(settled.response.status).toBe(201);
    const settledId = (settled.body as { paymentId: string }).paymentId;
    paymentIds.push(settledId);
    expect(uniquePaymentIds.has(settledId)).toBe(true);
    await expect(models.Payment.countDocuments({ paymentId: settledId })).resolves.toBe(
      1,
    );
  });

  it("enforces tenant isolation, scopes, and authentication on the payment API", async () => {
    const created = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantA.apiKey),
      body: JSON.stringify({ chain: chainId, token: tokenId, amount: "1000" }),
    });
    expect(created.response.status).toBe(201);
    const paymentId = trackPayment(created.body);

    const foreign = await request(`/api/v1/payments/${paymentId}`, {
      headers: merchantHeaders(merchantB.apiKey, { "x-request-id": "phase05-same" }),
    });
    const missing = await request(`/api/v1/payments/payment_${namespace}-missing`, {
      headers: merchantHeaders(merchantB.apiKey, { "x-request-id": "phase05-same" }),
    });
    expect(foreign.response.status).toBe(404);
    expect(missing.response.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);

    const own = await request(`/api/v1/payments/${paymentId}`, {
      headers: merchantHeaders(merchantA.apiKey),
    });
    expect(own.response.status).toBe(200);
    expect(own.body).toMatchObject({
      paymentId,
      status: "pending",
      amount: "1000",
      confirmations: 0,
      confirmed: false,
      screeningStatus: "clear",
    });

    const noAuth = await request("/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ chain: chainId, token: tokenId, amount: "1000" }),
    });
    expect(noAuth.response.status).toBe(401);
    const adminOnMerchantRoute = await request("/api/v1/payments", {
      method: "POST",
      headers: { authorization: `Bearer ${adminAccess}` },
      body: JSON.stringify({ chain: chainId, token: tokenId, amount: "1000" }),
    });
    expect(adminOnMerchantRoute.response.status).toBe(401);

    const readOnlyGenerated = generateMerchantApiKey("development");
    await models.MerchantCredential.create({
      credentialId: `credential_phase05_readonly_${namespace}`,
      merchantId: merchantB.merchantId,
      prefix: readOnlyGenerated.prefix,
      secretHash: await hashSecret(readOnlyGenerated.key),
      scopes: ["merchant:read"],
      status: "active",
    });
    const readOnlyApiKey = readOnlyGenerated.key;
    const forbiddenCreate = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(readOnlyApiKey),
      body: JSON.stringify({ chain: chainId, token: tokenId, amount: "1000" }),
    });
    expect(forbiddenCreate.response.status).toBe(403);
    expect((forbiddenCreate.body as { error: { code: string } }).error.code).toBe(
      "FORBIDDEN",
    );
    const allowedRead = await request(`/api/v1/payments/${paymentId}`, {
      headers: merchantHeaders(readOnlyApiKey),
    });
    expect(allowedRead.response.status).toBe(404);
  });

  it("rejects disabled or unknown registry entries and missing wallets", async () => {
    const unknownToken = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantA.apiKey),
      body: JSON.stringify({
        chain: chainId,
        token: `phase05-missing-${namespace}`,
        amount: "1000",
      }),
    });
    expect(unknownToken.response.status).toBe(400);

    const unknownChain = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantA.apiKey),
      body: JSON.stringify({
        chain: `phase05-chain-missing-${namespace}`,
        token: tokenId,
        amount: "1000",
      }),
    });
    expect(unknownChain.response.status).toBe(400);

    const noWallet = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantD.apiKey),
      body: JSON.stringify({ chain: chainId, token: tokenId, amount: "1000" }),
    });
    expect(noWallet.response.status).toBe(400);
    expect(JSON.stringify(noWallet.body)).toContain(
      "No active wallet is registered for this chain",
    );

    const deactivated = await request(
      `/api/v1/admin/tokens/${tokenId}/deactivation`,
      json(
        "POST",
        {
          expectedVersion: 1,
          force: true,
          confirmation: `DISABLE ${tokenId} WITH OPEN PAYMENTS`,
          reason: "Phase 05 integration check of disabled-token rejection",
        },
        { authorization: `Bearer ${adminAccess}` },
      ),
    );
    expect(deactivated.response.status, JSON.stringify(deactivated.body)).toBe(200);
    const disabledToken = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantA.apiKey),
      body: JSON.stringify({ chain: chainId, token: tokenId, amount: "1000" }),
    });
    expect(disabledToken.response.status).toBe(400);
    const reactivated = await request(
      `/api/v1/admin/tokens/${tokenId}/activation`,
      json("POST", { expectedVersion: 2 }, { authorization: `Bearer ${adminAccess}` }),
    );
    expect(reactivated.response.status, JSON.stringify(reactivated.body)).toBe(200);
    const restored = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantA.apiKey),
      body: JSON.stringify({ chain: chainId, token: tokenId, amount: "1000" }),
    });
    expect(restored.response.status, JSON.stringify(restored.body)).toBe(201);
    trackPayment(restored.body);
  });

  it("holds payments whose destination address is sanctioned", async () => {
    const created = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantC.apiKey),
      body: JSON.stringify({ chain: chainId, token: tokenId, amount: "1000" }),
    });
    expect(created.response.status, JSON.stringify(created.body)).toBe(201);
    const body = created.body as Record<string, unknown>;
    const paymentId = trackPayment(body);
    expect(body).toMatchObject({
      recipientAddress: sanctionedSeedAddress0,
      screeningStatus: "blocked",
      status: "pending",
    });
    const payment = await models.Payment.findOne({ paymentId }).lean();
    expect(payment?.screeningStatus).toBe("blocked");
    const screening = await models.ComplianceScreening.findOne({
      normalizedAddress: sanctionedSeedAddress0.toLowerCase(),
    }).lean();
    expect(screening).toMatchObject({
      sanctioned: true,
      riskLevel: "blocked",
      provider: "static-list",
      listVersion: "local-test-v1",
    });
    const audit = await models.AuditLog.findOne({
      entityType: "Payment",
      entityId: paymentId,
    }).lean();
    expect(audit?.metadata).toMatchObject({ screeningVerdict: "blocked" });
  });

  it("fails closed when the derivation index space is exhausted", async () => {
    await models.MerchantWallet.collection.updateOne(
      { xpubId: walletB },
      { $set: { nextDerivationIndex: 2_147_483_648 } },
    );
    const rejected = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantB.apiKey),
      body: JSON.stringify({ chain: chainId, token: tokenId, amount: "1000" }),
    });
    expect(rejected.response.status).toBe(503);
    expect((rejected.body as { error: { code: string } }).error.code).toBe(
      "INTERNAL_ERROR",
    );
    await expect(
      models.Payment.countDocuments({ merchantId: merchantB.merchantId }),
    ).resolves.toBe(0);
    await expect(
      models.WalletAddress.countDocuments({ merchantId: merchantB.merchantId }),
    ).resolves.toBe(0);
    const wallet = await models.MerchantWallet.findOne({ xpubId: walletB }).lean();
    expect(wallet?.nextDerivationIndex).toBe(2_147_483_648);
    await models.MerchantWallet.collection.updateOne(
      { xpubId: walletB },
      { $set: { nextDerivationIndex: 0 } },
    );
  });

  it("represents lazy expiry and capped confirmations on the read path", async () => {
    const created = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantA.apiKey),
      body: JSON.stringify({ chain: chainId, token: tokenId, amount: "1000" }),
    });
    expect(created.response.status).toBe(201);
    const paymentId = trackPayment(created.body);

    await models.Payment.collection.updateOne(
      { paymentId },
      { $set: { expiresAt: new Date(Date.now() - 60_000) } },
    );
    const expiredView = await request(`/api/v1/payments/${paymentId}`, {
      headers: merchantHeaders(merchantA.apiKey),
    });
    expect(expiredView.response.status).toBe(200);
    expect(expiredView.body).toMatchObject({ status: "expired", confirmed: false });
    const stored = await models.Payment.findOne({ paymentId }).lean();
    expect(stored?.status).toBe("pending");

    const confirming = await request("/api/v1/payments", {
      method: "POST",
      headers: merchantHeaders(merchantA.apiKey),
      body: JSON.stringify({ chain: chainId, token: tokenId, amount: "1100" }),
    });
    expect(confirming.response.status).toBe(201);
    const confirmingId = trackPayment(confirming.body);
    await models.Payment.collection.updateOne(
      { paymentId: confirmingId },
      { $set: { status: "confirming", confirmations: 10 } },
    );
    const cappedView = await request(`/api/v1/payments/${confirmingId}`, {
      headers: merchantHeaders(merchantA.apiKey),
    });
    expect(cappedView.response.status).toBe(200);
    expect(cappedView.body).toMatchObject({
      status: "confirming",
      confirmations: 2,
      confirmed: false,
    });
    await models.Payment.collection.updateOne(
      { paymentId: confirmingId },
      { $set: { status: "confirmed", confirmedAt: new Date() } },
    );
    const confirmedView = await request(`/api/v1/payments/${confirmingId}`, {
      headers: merchantHeaders(merchantA.apiKey),
    });
    expect(confirmedView.body).toMatchObject({
      status: "confirmed",
      confirmations: 2,
      confirmed: true,
    });
    const serialized = JSON.stringify(confirmedView.body);
    for (const forbidden of [
      "xpub",
      "tpub",
      "derivationIndex",
      "walletAddressId",
      "mongodb",
      "local-rpc",
      "http://",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("allocates unique addresses under concurrent creation", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        request("/api/v1/payments", {
          method: "POST",
          headers: merchantHeaders(merchantA.apiKey),
          body: JSON.stringify({ chain: chainId, token: tokenId, amount: "1200" }),
        }),
      ),
    );
    for (const attempt of attempts) {
      expect(attempt.response.status, JSON.stringify(attempt.body)).toBe(201);
      trackPayment(attempt.body);
    }
    const addresses = attempts.map(
      (attempt) => (attempt.body as { recipientAddress: string }).recipientAddress,
    );
    expect(new Set(addresses).size).toBe(8);
    const paymentIdsFromAttempts = attempts.map(
      (attempt) => (attempt.body as { paymentId: string }).paymentId,
    );
    const walletAddresses = await models.WalletAddress.find({
      assignedPaymentId: { $in: paymentIdsFromAttempts },
    }).lean();
    expect(walletAddresses.length).toBe(8);
    expect(new Set(walletAddresses.map((entry) => entry.derivationIndex)).size).toBe(8);
    expect(new Set(walletAddresses.map((entry) => entry.normalizedAddress)).size).toBe(
      8,
    );
  });

  it("rate limits payment creation per credential", async () => {
    let sawRateLimit = false;
    let last: HttpResult | undefined;
    for (let attempt = 0; attempt < 70 && !sawRateLimit; attempt += 1) {
      last = await request("/api/v1/payments", {
        method: "POST",
        headers: merchantHeaders(merchantE.apiKey),
        body: JSON.stringify({ chain: chainId, token: tokenId, amount: "99" }),
      });
      sawRateLimit = last.response.status === 429;
    }
    expect(sawRateLimit).toBe(true);
    expect(last?.response.headers.get("retry-after")).toBeTruthy();
    expect((last?.body as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    await expect(
      models.Payment.countDocuments({ merchantId: merchantE.merchantId }),
    ).resolves.toBe(0);
  }, 120_000);
});
