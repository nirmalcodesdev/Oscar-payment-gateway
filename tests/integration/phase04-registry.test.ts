import { randomUUID } from "node:crypto";

import mongoose, { type Connection } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RegistrySnapshotRepository } from "../../src/application/registry/registry-service.js";
import { EnabledRegistryReader } from "../../src/application/registry/registry-reader.js";
import { generateMerchantApiKey } from "../../src/infrastructure/auth/merchant-api-key.js";
import { hashSecret } from "../../src/infrastructure/auth/secret-hasher.js";
import { registerPersistenceModels } from "../../src/infrastructure/mongodb/models.js";
import { withRequiredTransaction } from "../../src/infrastructure/mongodb/transactions.js";

const apiBaseUrl = process.env["PHASE03_API_URL"];
const integrationUri = process.env["MONGODB_INTEGRATION_URI"];
const runIntegration = apiBaseUrl !== undefined && integrationUri !== undefined;
const describeWithServices = runIntegration ? describe : describe.skip;

const namespace = randomUUID();
const adminPassword = "phase04-admin-password-that-is-long-enough";
const chainId = `phase04-chain-${namespace}`;
const standardTokenId = `phase04-usdc-${namespace}`;
const nonStandardTokenId = `phase04-nonstandard-${namespace}`;
const standardAddress = "0x1111111111111111111111111111111111111111";
const nonStandardAddress = "0x2222222222222222222222222222222222222222";
const missingAddress = "0x3333333333333333333333333333333333333333";
const unsafeAddress = "0x4444444444444444444444444444444444444444";

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

function json(method: string, body: unknown, accessToken?: string): RequestInit {
  return {
    method,
    headers:
      accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  };
}

function chainInput(id: string, providerIds = ["local-rpc-a", "local-rpc-b"]) {
  return {
    chainId: id,
    networkChainId: 11155111,
    name: "Phase 04 Sepolia",
    providerIds,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    requiredConfirmations: 2,
  };
}

function tokenInput(
  tokenId: string,
  chain: string,
  contractAddress: string,
  verificationPolicy: "event_only" | "balance_delta_required" = "event_only",
  symbol = "USDC",
) {
  return {
    tokenId,
    chain,
    symbol,
    contractAddress,
    decimals: 6,
    minAmount: "1",
    maxAmount: "1000000000000",
    verificationPolicy,
  };
}

describeWithServices("Phase 04 live registry administration", () => {
  let connection!: Connection;
  let models!: ReturnType<typeof registerPersistenceModels>;
  let adminAccessA = "";
  let adminAccessB = "";
  let merchantApiKey = "";
  const adminIds = [`admin_phase04_${namespace}`, `admin_phase04b_${namespace}`];
  const adminEmails = [
    `phase04-${namespace}@example.com`,
    `phase04b-${namespace}@example.com`,
  ];
  const createdChainIds: string[] = [];
  const createdTokenIds: string[] = [];
  const paymentIds: string[] = [];

  beforeAll(async () => {
    if (integrationUri === undefined) throw new Error("Integration URI is required");
    connection = mongoose.createConnection(integrationUri, {
      serverSelectionTimeoutMS: 15_000,
      directConnection: true,
      autoIndex: false,
    });
    await connection.asPromise();
    models = registerPersistenceModels(connection);
    for (let index = 0; index < adminIds.length; index += 1) {
      await models.AdminIdentity.create({
        adminId: adminIds[index],
        email: adminEmails[index],
        passwordHash: await hashSecret(adminPassword),
        role: "admin",
        status: "active",
        tokenVersion: 0,
      });
      const login = await request(
        "/api/v1/admin/auth/login",
        json("POST", { email: adminEmails[index], password: adminPassword }),
      );
      expect(login.response.status).toBe(200);
      const accessToken = (login.body as { accessToken: string }).accessToken;
      if (index === 0) adminAccessA = accessToken;
      else adminAccessB = accessToken;
    }

    const merchantId = `merchant_phase04_${namespace}`;
    const generated = generateMerchantApiKey("development");
    merchantApiKey = generated.key;
    await models.Merchant.create({
      merchantId,
      email: `phase04-merchant-${namespace}@example.com`,
      status: "active",
      emailVerifiedAt: new Date(),
      approvedAt: new Date(),
      approvedBy: adminIds[0],
      version: 0,
    });
    await models.MerchantCredential.create({
      credentialId: `credential_phase04_${namespace}`,
      merchantId,
      prefix: generated.prefix,
      secretHash: await hashSecret(generated.key),
      scopes: ["merchant:read"],
      status: "active",
    });
  });

  afterAll(async () => {
    await models.Payment.collection.deleteMany({ paymentId: { $in: paymentIds } });
    await models.Token.collection.deleteMany({ tokenId: { $in: createdTokenIds } });
    await models.Chain.collection.deleteMany({ chainId: { $in: createdChainIds } });
    await models.AdminSession.collection.deleteMany({ adminId: { $in: adminIds } });
    await models.AdminIdentity.collection.deleteMany({ adminId: { $in: adminIds } });
    await models.MerchantCredential.collection.deleteMany({
      credentialId: `credential_phase04_${namespace}`,
    });
    await models.Merchant.collection.deleteMany({
      merchantId: `merchant_phase04_${namespace}`,
    });
    await connection.close();
  });

  it("enforces admin-only strict creation and separate live chain activation", async () => {
    const missingAuth = await request(
      "/api/v1/admin/chains",
      json("POST", chainInput(chainId)),
    );
    expect(missingAuth.response.status).toBe(401);
    const merchantAuth = await request("/api/v1/admin/chains", {
      method: "POST",
      headers: { "x-oscar-merchant-api-key": merchantApiKey },
      body: JSON.stringify(chainInput(chainId)),
    });
    expect(merchantAuth.response.status).toBe(401);
    const rawUrl = await request(
      "/api/v1/admin/chains",
      json(
        "POST",
        {
          ...chainInput(chainId),
          rpcProviders: [{ providerId: "attacker", url: "http://127.0.0.1" }],
        },
        adminAccessA,
      ),
    );
    expect(rawUrl.response.status).toBe(400);

    const created = await request(
      "/api/v1/admin/chains",
      json("POST", chainInput(chainId), adminAccessA),
    );
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({ chainId, enabled: false, version: 0 });
    expect(JSON.stringify(created.body)).not.toContain("rpc-mock");
    expect(JSON.stringify(created.body)).not.toContain("http://");
    createdChainIds.push(chainId);
    const persisted = await models.Chain.collection.findOne({ chainId });
    expect(
      (persisted?.["rpcProviders"] as Record<string, unknown>[]).every(
        (provider) => provider["url"] === undefined,
      ),
    ).toBe(true);

    const activated = await request(
      `/api/v1/admin/chains/${chainId}/activation`,
      json("POST", { expectedVersion: 0 }, adminAccessA),
    );
    expect(activated.response.status).toBe(200);
    expect(activated.body).toMatchObject({ enabled: true, version: 1 });
    const updated = await request(
      `/api/v1/admin/chains/${chainId}`,
      json("PATCH", { expectedVersion: 1, requiredConfirmations: 3 }, adminAccessA),
    );
    expect(updated.response.status).toBe(200);
    expect(updated.body).toMatchObject({ requiredConfirmations: 3, version: 2 });
    const noDelete = await request(`/api/v1/admin/chains/${chainId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${adminAccessA}` },
    });
    expect(noDelete.response.status).toBe(404);
  });

  it("fails activation closed for wrong, disagreeing, and unreachable providers", async () => {
    const cases = [
      {
        id: `phase04-wrong-${namespace}`,
        input: { ...chainInput(`phase04-wrong-${namespace}`), networkChainId: 1 },
      },
      {
        id: `phase04-disagree-${namespace}`,
        input: {
          ...chainInput(`phase04-disagree-${namespace}`, [
            "local-rpc-a",
            "local-rpc-wrong",
          ]),
          networkChainId: 11155112,
        },
      },
      {
        id: `phase04-unreachable-${namespace}`,
        input: {
          ...chainInput(`phase04-unreachable-${namespace}`, [
            "local-rpc-a",
            "local-rpc-unreachable",
          ]),
          networkChainId: 11155113,
        },
      },
    ];
    for (const testCase of cases) {
      const created = await request(
        "/api/v1/admin/chains",
        json("POST", testCase.input, adminAccessA),
      );
      expect(created.response.status, JSON.stringify(created.body)).toBe(201);
      createdChainIds.push(testCase.id);
      const activated = await request(
        `/api/v1/admin/chains/${testCase.id}/activation`,
        json("POST", { expectedVersion: 0 }, adminAccessA),
      );
      expect(activated.response.status).toBe(502);
      expect(activated.body).toMatchObject({
        error: { code: "CHAIN_ERROR", message: "Registry verification failed" },
      });
      expect(JSON.stringify(activated.body)).not.toContain("local-rpc");
      await expect(
        models.Chain.countDocuments({ chainId: testCase.id, enabled: true }),
      ).resolves.toBe(0);
    }
  });

  it("verifies standard tokens and rejects contract, decimal, and duplicate ambiguity", async () => {
    const created = await request(
      "/api/v1/admin/tokens",
      json("POST", tokenInput(standardTokenId, chainId, standardAddress), adminAccessA),
    );
    expect(created.response.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      enabled: false,
      verificationStatus: "unverified",
    });
    createdTokenIds.push(standardTokenId);
    const activated = await request(
      `/api/v1/admin/tokens/${standardTokenId}/activation`,
      json("POST", { expectedVersion: 0 }, adminAccessA),
    );
    expect(activated.response.status).toBe(200);
    expect(activated.body).toMatchObject({
      enabled: true,
      verificationStatus: "verified",
      verifiedDecimals: 6,
      verifiedSymbol: "USDC",
      verifiedTotalSupply: "1000000000000",
      version: 1,
    });
    const updated = await request(
      `/api/v1/admin/tokens/${standardTokenId}`,
      json("PATCH", { expectedVersion: 1, minAmount: "10" }, adminAccessA),
    );
    expect(updated.response.status).toBe(200);
    expect(updated.body).toMatchObject({ minAmount: "10", version: 2 });

    const duplicate = await request(
      "/api/v1/admin/tokens",
      json(
        "POST",
        tokenInput(`phase04-duplicate-${namespace}`, chainId, standardAddress),
        adminAccessA,
      ),
    );
    expect(duplicate.response.status).toBe(409);

    const failures = [
      {
        id: `phase04-decimals-${namespace}`,
        body: {
          ...tokenInput(
            `phase04-decimals-${namespace}`,
            chainId,
            "0x5555555555555555555555555555555555555555",
            "event_only",
            "DECIMALS",
          ),
          decimals: 18,
        },
      },
      {
        id: `phase04-missing-${namespace}`,
        body: tokenInput(
          `phase04-missing-${namespace}`,
          chainId,
          missingAddress,
          "event_only",
          "MISSING",
        ),
      },
    ];
    for (const failure of failures) {
      const token = await request(
        "/api/v1/admin/tokens",
        json("POST", failure.body, adminAccessA),
      );
      expect(token.response.status).toBe(201);
      createdTokenIds.push(failure.id);
      const activation = await request(
        `/api/v1/admin/tokens/${failure.id}/activation`,
        json("POST", { expectedVersion: 0 }, adminAccessA),
      );
      expect(activation.response.status).toBe(502);
      await expect(
        models.Token.countDocuments({ tokenId: failure.id, enabled: true }),
      ).resolves.toBe(0);
    }
  });

  it("requires an explicit audited review for non-standard token metadata", async () => {
    const created = await request(
      "/api/v1/admin/tokens",
      json(
        "POST",
        tokenInput(
          nonStandardTokenId,
          chainId,
          nonStandardAddress,
          "balance_delta_required",
          "NONSTD",
        ),
        adminAccessB,
      ),
    );
    expect(created.response.status, JSON.stringify(created.body)).toBe(201);
    createdTokenIds.push(nonStandardTokenId);
    const reviewRequired = await request(
      `/api/v1/admin/tokens/${nonStandardTokenId}/activation`,
      json("POST", { expectedVersion: 0 }, adminAccessB),
    );
    expect(reviewRequired.response.status).toBe(202);
    expect(reviewRequired.body).toMatchObject({
      enabled: false,
      verificationStatus: "manual_review",
      version: 1,
    });
    const approved = await request(
      `/api/v1/admin/tokens/${nonStandardTokenId}/activation`,
      json(
        "POST",
        {
          expectedVersion: 1,
          manualReview: {
            acknowledged: true,
            reason: "Reviewed optional symbol response and require balance deltas",
          },
        },
        adminAccessB,
      ),
    );
    expect(approved.response.status).toBe(200);
    expect(approved.body).toMatchObject({
      enabled: true,
      verificationStatus: "manual_review",
      version: 2,
    });
    const audit = await models.AuditLog.findOne({
      entityType: "Token",
      entityId: nonStandardTokenId,
      action: "token_activated_after_manual_review",
    }).lean();
    expect(audit?.actorId).toBe(adminIds[1]);
    expect(audit?.metadata).toMatchObject({
      reviewReason: "Reviewed optional symbol response and require balance deltas",
    });

    const unsafeTokenId = `phase04-event-only-${namespace}`;
    const unsafeCreated = await request(
      "/api/v1/admin/tokens",
      json(
        "POST",
        tokenInput(unsafeTokenId, chainId, unsafeAddress, "event_only", "UNSAFE"),
        adminAccessB,
      ),
    );
    expect(unsafeCreated.response.status).toBe(201);
    createdTokenIds.push(unsafeTokenId);
    const unsafeReview = await request(
      `/api/v1/admin/tokens/${unsafeTokenId}/activation`,
      json("POST", { expectedVersion: 0 }, adminAccessB),
    );
    expect(unsafeReview.response.status).toBe(202);
    const unsafeApproval = await request(
      `/api/v1/admin/tokens/${unsafeTokenId}/activation`,
      json(
        "POST",
        {
          expectedVersion: 1,
          manualReview: {
            acknowledged: true,
            reason: "Attempted review without required balance delta policy",
          },
        },
        adminAccessB,
      ),
    );
    expect(unsafeApproval.response.status).toBe(400);
    await expect(
      models.Token.countDocuments({ tokenId: unsafeTokenId, enabled: true }),
    ).resolves.toBe(0);
  });

  it("prevents disable races and audits an explicit open-payment override", async () => {
    const raceTokenId = `phase04-race-${namespace}`;
    const raceAddress = "0x7777777777777777777777777777777777777777";
    const raceCreated = await request(
      "/api/v1/admin/tokens",
      json(
        "POST",
        tokenInput(raceTokenId, chainId, raceAddress, "event_only", "RACE"),
        adminAccessB,
      ),
    );
    expect(raceCreated.response.status, JSON.stringify(raceCreated.body)).toBe(201);
    createdTokenIds.push(raceTokenId);
    const raceActivated = await request(
      `/api/v1/admin/tokens/${raceTokenId}/activation`,
      json("POST", { expectedVersion: 0 }, adminAccessB),
    );
    expect(raceActivated.response.status).toBe(200);

    const racePaymentId = `phase04-race-payment-${namespace}`;
    paymentIds.push(racePaymentId);
    const snapshots = new RegistrySnapshotRepository(connection);
    const snapshotAttempt = withRequiredTransaction(connection, async (session) => {
      const snapshot = await snapshots.reservePaymentConfiguration(
        chainId,
        raceTokenId,
        session,
      );
      await models.Payment.create(
        [
          {
            paymentId: racePaymentId,
            merchantId: `merchant_phase04_${namespace}`,
            chain: chainId,
            token: raceTokenId,
            walletAddressId: `wallet_phase04_race_${namespace}`,
            amount: "1000",
            status: "pending",
            version: 0,
            requiredConfirmations: snapshot.requiredConfirmations,
            tokenVerificationPolicy: snapshot.tokenVerificationPolicy,
            confirmations: 0,
            screeningStatus: "pending",
            expiresAt: new Date(Date.now() + 60_000),
          },
        ],
        { session },
      );
      return snapshot;
    });
    const disableAttempt = request(
      `/api/v1/admin/tokens/${raceTokenId}/deactivation`,
      json("POST", { expectedVersion: 1 }, adminAccessB),
    );
    const [snapshotResult, disableResult] = await Promise.allSettled([
      snapshotAttempt,
      disableAttempt,
    ]);
    const paymentExists =
      (await models.Payment.countDocuments({ paymentId: racePaymentId })) === 1;
    expect(disableResult.status).toBe("fulfilled");
    if (disableResult.status === "fulfilled") {
      if (disableResult.value.response.status === 200) {
        expect(snapshotResult.status).toBe("rejected");
        expect(paymentExists).toBe(false);
      } else {
        expect(disableResult.value.response.status).toBe(409);
        expect(snapshotResult.status).toBe("fulfilled");
        expect(paymentExists).toBe(true);
      }
    }
    expect(
      await models.Token.exists({ tokenId: raceTokenId, enabled: paymentExists }),
    ).not.toBeNull();

    const openPaymentId = `phase04-open-payment-${namespace}`;
    paymentIds.push(openPaymentId);
    await models.Payment.create({
      paymentId: openPaymentId,
      merchantId: `merchant_phase04_${namespace}`,
      chain: chainId,
      token: standardTokenId,
      walletAddressId: `wallet_phase04_open_${namespace}`,
      amount: "1000",
      status: "pending",
      version: 0,
      requiredConfirmations: 3,
      tokenVerificationPolicy: "event_only",
      confirmations: 0,
      screeningStatus: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const blocked = await request(
      `/api/v1/admin/tokens/${standardTokenId}/deactivation`,
      json("POST", { expectedVersion: 2 }, adminAccessB),
    );
    expect(blocked.response.status).toBe(409);
    const wrongConfirmation = await request(
      `/api/v1/admin/tokens/${standardTokenId}/deactivation`,
      json(
        "POST",
        {
          expectedVersion: 2,
          force: true,
          confirmation: "DISABLE THE WRONG TOKEN",
          reason: "Operator requested an explicit reconciliation hold",
        },
        adminAccessB,
      ),
    );
    expect(wrongConfirmation.response.status).toBe(409);
    const reader = new EnabledRegistryReader(connection);
    expect(
      (await reader.refresh()).tokens.some(
        ({ tokenId }) => tokenId === standardTokenId,
      ),
    ).toBe(true);
    const forced = await request(
      `/api/v1/admin/tokens/${standardTokenId}/deactivation`,
      json(
        "POST",
        {
          expectedVersion: 2,
          force: true,
          confirmation: `DISABLE ${standardTokenId} WITH OPEN PAYMENTS`,
          reason: "Operator accepted manual reconciliation for the open payment",
        },
        adminAccessB,
      ),
    );
    expect(forced.response.status).toBe(200);
    expect(forced.body).toMatchObject({ enabled: false, version: 3 });
    expect(
      (await reader.refresh()).tokens.some(
        ({ tokenId }) => tokenId === standardTokenId,
      ),
    ).toBe(false);
    const audit = await models.AuditLog.findOne({
      entityType: "Token",
      entityId: standardTokenId,
      action: "token_force_deactivated",
    }).lean();
    expect(audit?.metadata).toMatchObject({
      forceReason: "Operator accepted manual reconciliation for the open payment",
    });
  });
});
