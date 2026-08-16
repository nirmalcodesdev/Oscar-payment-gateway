import { Schema, type Connection, type InferSchemaType, type Model } from "mongoose";

import {
  blockHashPattern,
  evmAddressPattern,
  identifierPattern,
  immutableString,
  normalizedEvmAddressPattern,
  optionalNonNegativeAmount,
  publicExtendedKeyPattern,
  rejectDeletes,
  rejectMutations,
  requiredIdentifier,
  requiredNonNegativeAmount,
  requiredPositiveAmount,
  requireVersionedUpdates,
  sha256Pattern,
  strictSchemaOptions,
  transactionHashPattern,
} from "./schema-helpers.js";

const timestampOptions = { ...strictSchemaOptions, timestamps: true };
const immutableIdentifier = { ...requiredIdentifier, immutable: true };
const immutableReference = (ref: string) => ({ ...immutableIdentifier, ref });
const immutableDate = { type: Date, required: true, immutable: true };
const boundedCounter = {
  type: Number,
  required: true,
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
};
const immutableBoundedCounter = { ...boundedCounter, immutable: true };
const immutableAddress = immutableString({ match: evmAddressPattern });
const immutableNormalizedAddress = immutableString({
  match: normalizedEvmAddressPattern,
});

export const merchantSchema = new Schema(
  {
    merchantId: immutableIdentifier,
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 320,
    },
    status: {
      type: String,
      required: true,
      enum: ["pending_approval", "active", "suspended", "rejected"],
      default: "pending_approval",
    },
    emailVerifiedAt: { type: Date },
    approvedAt: { type: Date },
    approvedBy: { type: String, match: identifierPattern },
    webhookUrl: { type: String, maxlength: 2048 },
    version: { ...boundedCounter, default: 0 },
  },
  { ...timestampOptions, collection: "merchants" },
);
merchantSchema.index({ merchantId: 1 }, { unique: true, name: "uq_merchant_id" });
merchantSchema.index({ email: 1 }, { unique: true, name: "uq_merchant_email" });

export const merchantCredentialSchema = new Schema(
  {
    credentialId: immutableIdentifier,
    merchantId: immutableReference("Merchant"),
    prefix: immutableString({ maxlength: 32, match: /^[A-Za-z0-9_-]{6,32}$/ }),
    secretHash: { type: String, required: true, select: false, maxlength: 1024 },
    scopes: [{ type: String, required: true, maxlength: 128 }],
    status: { type: String, required: true, enum: ["active", "revoked", "expired"] },
    expiresAt: { type: Date },
    revokedAt: { type: Date },
    lastUsedAt: { type: Date },
  },
  { ...timestampOptions, collection: "merchant_credentials" },
);
merchantCredentialSchema.index(
  { credentialId: 1 },
  { unique: true, name: "uq_merchant_credential_id" },
);
merchantCredentialSchema.index(
  { prefix: 1 },
  { unique: true, name: "uq_merchant_credential_prefix" },
);
merchantCredentialSchema.index(
  { merchantId: 1, status: 1 },
  { name: "ix_merchant_credential_status" },
);

export const merchantWalletSchema = new Schema(
  {
    xpubId: immutableIdentifier,
    merchantId: immutableReference("Merchant"),
    chain: immutableReference("Chain"),
    publicExtendedKey: immutableString({
      select: false,
      match: publicExtendedKeyPattern,
      maxlength: 256,
    }),
    fingerprint: immutableString({ match: /^[0-9a-f]{8,64}$/ }),
    nextDerivationIndex: { ...boundedCounter, default: 0 },
    status: { type: String, required: true, enum: ["active", "retired"] },
    version: { ...boundedCounter, default: 0 },
    retiredAt: { type: Date },
  },
  { ...timestampOptions, collection: "merchant_wallets" },
);
merchantWalletSchema.index(
  { xpubId: 1 },
  { unique: true, name: "uq_merchant_wallet_xpub_id" },
);
merchantWalletSchema.index(
  { merchantId: 1, chain: 1, status: 1 },
  { name: "ix_merchant_wallet_chain_status" },
);
merchantWalletSchema.index(
  { merchantId: 1, chain: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "active" },
    name: "uq_active_merchant_wallet_chain",
  },
);

export const walletAddressSchema = new Schema(
  {
    walletAddressId: immutableIdentifier,
    merchantId: immutableReference("Merchant"),
    chain: immutableReference("Chain"),
    address: immutableAddress,
    normalizedAddress: immutableNormalizedAddress,
    xpubId: immutableReference("MerchantWallet"),
    derivationIndex: immutableBoundedCounter,
    assignedPaymentId: {
      type: String,
      immutable: true,
      match: identifierPattern,
      ref: "Payment",
    },
    status: {
      type: String,
      required: true,
      enum: ["available", "assigned", "retired"],
    },
    assignedAt: { type: Date, immutable: true },
    retiredAt: { type: Date },
  },
  { ...timestampOptions, collection: "wallet_addresses" },
);
walletAddressSchema.index(
  { walletAddressId: 1 },
  { unique: true, name: "uq_wallet_address_id" },
);
walletAddressSchema.index(
  { chain: 1, normalizedAddress: 1 },
  { unique: true, name: "uq_chain_normalized_address" },
);
walletAddressSchema.index(
  { xpubId: 1, derivationIndex: 1 },
  { unique: true, name: "uq_xpub_derivation_index" },
);
walletAddressSchema.index(
  { assignedPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: { assignedPaymentId: { $type: "string" } },
    name: "uq_wallet_assigned_payment",
  },
);
walletAddressSchema.index(
  { merchantId: 1, chain: 1, status: 1 },
  { name: "ix_merchant_wallet_address_status" },
);
rejectDeletes(walletAddressSchema, "Wallet address");

export const paymentStatuses = [
  "pending",
  "matched",
  "confirming",
  "confirmed",
  "expired",
  "failed",
] as const;

export const paymentSchema = new Schema(
  {
    paymentId: immutableIdentifier,
    merchantId: immutableReference("Merchant"),
    chain: immutableReference("Chain"),
    token: immutableReference("Token"),
    walletAddressId: immutableReference("WalletAddress"),
    amount: { ...requiredPositiveAmount, immutable: true },
    amountReceived: optionalNonNegativeAmount,
    partialAmountReceived: optionalNonNegativeAmount,
    excessAmount: optionalNonNegativeAmount,
    underpaymentFlag: { type: Boolean, default: false },
    overpaymentFlag: { type: Boolean, default: false },
    status: { type: String, required: true, enum: paymentStatuses, default: "pending" },
    version: { ...boundedCounter, default: 0 },
    requiredConfirmations: { ...immutableBoundedCounter, min: 1 },
    tokenVerificationPolicy: {
      type: String,
      enum: ["event_only", "balance_delta_required"],
      immutable: true,
    },
    confirmations: { ...boundedCounter, default: 0 },
    screeningStatus: {
      type: String,
      required: true,
      enum: ["clear", "flagged", "blocked", "pending"],
      default: "pending",
    },
    // Deep-reorg automation hold (ADR 0012): set only by a finality incident;
    // cleared only by an audited manual disposition.
    automationHold: { type: Boolean, default: false },
    automationHoldReorgId: { type: String, match: identifierPattern },
    matchedEventId: { type: String, match: identifierPattern },
    transactionHash: { type: String, match: transactionHashPattern },
    expiresAt: immutableDate,
    matchedAt: { type: Date },
    confirmedAt: { type: Date },
    terminalAt: { type: Date },
  },
  { ...timestampOptions, collection: "payments" },
);
paymentSchema.index({ paymentId: 1 }, { unique: true, name: "uq_payment_id" });
paymentSchema.index(
  { merchantId: 1, paymentId: 1 },
  { unique: true, name: "uq_merchant_payment" },
);
paymentSchema.index(
  { walletAddressId: 1 },
  { unique: true, name: "uq_payment_wallet_address" },
);
paymentSchema.index(
  { chain: 1, token: 1, status: 1 },
  { name: "ix_payment_chain_token_status" },
);
paymentSchema.index(
  { merchantId: 1, status: 1, createdAt: -1 },
  { name: "ix_merchant_payment_status_created" },
);
paymentSchema.index({ status: 1, expiresAt: 1 }, { name: "ix_payment_expiry_sweep" });
requireVersionedUpdates(paymentSchema);
rejectDeletes(paymentSchema, "Payment");

const rpcProviderSchema = new Schema(
  {
    providerId: requiredIdentifier,
    operatorId: requiredIdentifier,
  },
  { _id: false, ...strictSchemaOptions },
);

const nativeCurrencySchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 128 },
    symbol: { type: String, required: true, maxlength: 32 },
    decimals: { type: Number, required: true, min: 0, max: 255 },
  },
  { _id: false, ...strictSchemaOptions },
);

export const chainSchema = new Schema(
  {
    chainId: immutableIdentifier,
    networkFamily: {
      type: String,
      required: true,
      enum: ["evm"],
      immutable: true,
    },
    networkChainId: {
      type: Number,
      required: true,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      immutable: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 128 },
    rpcProviders: {
      type: [rpcProviderSchema],
      required: true,
      validate: { validator: (providers: unknown[]) => providers.length >= 2 },
    },
    nativeCurrency: { type: nativeCurrencySchema, required: true },
    requiredConfirmations: { ...boundedCounter, min: 1 },
    enabled: { type: Boolean, required: true, default: false },
    version: { ...boundedCounter, default: 0 },
    allocationSequence: { ...boundedCounter, default: 0 },
    verifiedAt: { type: Date },
  },
  { ...timestampOptions, collection: "chains" },
);
chainSchema.index({ chainId: 1 }, { unique: true, name: "uq_chain_id" });
chainSchema.index({ enabled: 1 }, { name: "ix_chain_enabled" });
rejectDeletes(chainSchema, "Chain");

export const tokenSchema = new Schema(
  {
    tokenId: immutableIdentifier,
    chain: immutableReference("Chain"),
    symbol: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 32,
    },
    contractAddress: immutableAddress,
    normalizedContractAddress: immutableNormalizedAddress,
    decimals: { type: Number, required: true, min: 0, max: 255 },
    minAmount: requiredPositiveAmount,
    maxAmount: requiredPositiveAmount,
    verificationPolicy: {
      type: String,
      required: true,
      enum: ["event_only", "balance_delta_required"],
    },
    enabled: { type: Boolean, required: true, default: false },
    verificationStatus: {
      type: String,
      required: true,
      enum: ["unverified", "verified", "manual_review", "failed"],
      default: "unverified",
    },
    version: { ...boundedCounter, default: 0 },
    allocationSequence: { ...boundedCounter, default: 0 },
    verifiedAt: { type: Date },
    verifiedSymbol: { type: String, trim: true, uppercase: true, maxlength: 32 },
    verifiedDecimals: { type: Number, min: 0, max: 255 },
    verifiedTotalSupply: optionalNonNegativeAmount,
  },
  { ...timestampOptions, collection: "tokens" },
);
tokenSchema.index({ tokenId: 1 }, { unique: true, name: "uq_token_id" });
tokenSchema.index(
  { chain: 1, symbol: 1 },
  { unique: true, name: "uq_chain_token_symbol" },
);
tokenSchema.index(
  { chain: 1, normalizedContractAddress: 1 },
  { unique: true, name: "uq_chain_token_contract" },
);
tokenSchema.index({ chain: 1, enabled: 1 }, { name: "ix_chain_token_enabled" });
rejectDeletes(tokenSchema, "Token");

export const onChainEventSchema = new Schema(
  {
    eventId: immutableIdentifier,
    chain: immutableReference("Chain"),
    // Resolved during interpretation (ADR 0010), not captured at ingest, so it
    // is mutable; raw capture fields remain immutable.
    token: {
      type: String,
      match: identifierPattern,
      maxlength: 128,
      ref: "Token",
    },
    contractAddress: immutableAddress,
    normalizedContractAddress: immutableNormalizedAddress,
    transactionHash: immutableString({ match: transactionHashPattern }),
    logIndex: immutableBoundedCounter,
    blockNumber: immutableBoundedCounter,
    blockHash: immutableString({ match: blockHashPattern }),
    fromAddress: immutableAddress,
    normalizedFromAddress: immutableNormalizedAddress,
    toAddress: immutableAddress,
    normalizedToAddress: immutableNormalizedAddress,
    amount: { ...requiredNonNegativeAmount, immutable: true },
    rawEvent: { type: Schema.Types.Mixed, required: true, immutable: true },
    interpretationStatus: {
      type: String,
      enum: ["accepted", "rejected", "review"],
    },
    interpretationReason: {
      type: String,
      match: /^[a-z][a-z0-9_]{1,63}$/,
      maxlength: 64,
    },
    verifiedReceivedAmount: optionalNonNegativeAmount,
    interpretedAt: { type: Date },
    interpretationRevision: { type: String, match: sha256Pattern },
    matchedPaymentId: { type: String, match: identifierPattern, ref: "Payment" },
    canonical: { type: Boolean, required: true, default: true },
    confirmationsAtIngest: { type: Number, min: 0, max: Number.MAX_SAFE_INTEGER },
    ingestedAt: immutableDate,
  },
  { ...strictSchemaOptions, collection: "on_chain_events" },
);
onChainEventSchema.index(
  { eventId: 1 },
  { unique: true, name: "uq_on_chain_event_id" },
);
onChainEventSchema.index(
  { chain: 1, transactionHash: 1, logIndex: 1 },
  { unique: true, name: "uq_chain_transaction_log" },
);
onChainEventSchema.index(
  { matchedPaymentId: 1 },
  {
    partialFilterExpression: { matchedPaymentId: { $type: "string" } },
    name: "ix_event_payment_claim",
  },
);
onChainEventSchema.index(
  { chain: 1, contractAddress: 1, blockNumber: 1 },
  { name: "ix_event_chain_contract_block" },
);
onChainEventSchema.index(
  { chain: 1, normalizedContractAddress: 1, blockNumber: 1 },
  { name: "ix_event_chain_normalized_contract_block" },
);
onChainEventSchema.index(
  { chain: 1, normalizedToAddress: 1, canonical: 1 },
  { name: "ix_event_chain_recipient_canonical" },
);
rejectDeletes(onChainEventSchema, "On-chain event");

export const chainCursorSchema = new Schema(
  {
    chain: immutableReference("Chain"),
    lastProcessedBlock: boundedCounter,
    lastProcessedBlockHash: { type: String, required: true, match: blockHashPattern },
    version: { ...boundedCounter, default: 0 },
    updatedAt: { type: Date, required: true },
  },
  { ...strictSchemaOptions, collection: "chain_cursors" },
);
chainCursorSchema.index({ chain: 1 }, { unique: true, name: "uq_chain_cursor" });

export const observedBlockSchema = new Schema(
  {
    chain: immutableReference("Chain"),
    blockNumber: immutableBoundedCounter,
    blockHash: immutableString({ match: blockHashPattern }),
    parentHash: immutableString({ match: blockHashPattern }),
    canonical: { type: Boolean, required: true, default: true },
    observedAt: immutableDate,
  },
  { ...strictSchemaOptions, collection: "observed_blocks" },
);
observedBlockSchema.index(
  { chain: 1, blockNumber: 1, blockHash: 1 },
  { unique: true, name: "uq_observed_block_identity" },
);
observedBlockSchema.index(
  { chain: 1, blockNumber: 1, canonical: 1 },
  { name: "ix_observed_block_canonical" },
);
rejectDeletes(observedBlockSchema, "Observed block");

export const reorgRecordSchema = new Schema(
  {
    reorgId: immutableIdentifier,
    chain: immutableReference("Chain"),
    fromBlock: immutableBoundedCounter,
    toBlock: immutableBoundedCounter,
    detectedAt: immutableDate,
    orphanedTxHashes: [{ type: String, required: true, match: transactionHashPattern }],
    affectedPaymentIds: [
      { type: String, required: true, match: identifierPattern, ref: "Payment" },
    ],
    resolvedAt: { type: Date },
  },
  { ...strictSchemaOptions, collection: "reorg_records" },
);
reorgRecordSchema.index({ reorgId: 1 }, { unique: true, name: "uq_reorg_id" });
reorgRecordSchema.index(
  { chain: 1, detectedAt: -1 },
  { name: "ix_reorg_chain_detected" },
);
rejectDeletes(reorgRecordSchema, "Reorg record");

export const auditLogSchema = new Schema(
  {
    auditId: immutableIdentifier,
    scope: immutableIdentifier,
    sequence: immutableBoundedCounter,
    entityType: immutableString({ maxlength: 128 }),
    entityId: immutableString({ maxlength: 128 }),
    action: immutableString({ maxlength: 128 }),
    actorType: immutableString({ enum: ["merchant", "admin", "system"] }),
    actorId: immutableString({ maxlength: 128 }),
    before: { type: Schema.Types.Mixed, immutable: true },
    after: { type: Schema.Types.Mixed, immutable: true },
    eventId: { type: String, immutable: true, match: identifierPattern },
    transactionHash: { type: String, immutable: true, match: transactionHashPattern },
    metadata: { type: Schema.Types.Mixed, immutable: true },
    occurredAt: immutableDate,
    hashVersion: { type: Number, required: true, immutable: true, enum: [1] },
    previousHash: immutableString({ match: sha256Pattern }),
    entryHash: immutableString({ match: sha256Pattern }),
  },
  { ...strictSchemaOptions, collection: "audit_logs" },
);
auditLogSchema.index({ auditId: 1 }, { unique: true, name: "uq_audit_id" });
auditLogSchema.index(
  { scope: 1, sequence: 1 },
  { unique: true, name: "uq_audit_scope_sequence" },
);
auditLogSchema.index({ entryHash: 1 }, { unique: true, name: "uq_audit_entry_hash" });
auditLogSchema.index(
  { entityType: 1, entityId: 1, occurredAt: 1 },
  { name: "ix_audit_entity" },
);
rejectMutations(auditLogSchema, "Audit log");

export const auditChainHeadSchema = new Schema(
  {
    scope: immutableIdentifier,
    sequence: boundedCounter,
    entryHash: { type: String, required: true, match: sha256Pattern },
    version: { ...boundedCounter, default: 0 },
  },
  { ...timestampOptions, collection: "audit_chain_heads" },
);
auditChainHeadSchema.index(
  { scope: 1 },
  { unique: true, name: "uq_audit_chain_scope" },
);

export const idempotencyKeySchema = new Schema(
  {
    key: immutableString({ maxlength: 255 }),
    scope: immutableString({ maxlength: 255 }),
    requestFingerprint: immutableString({ match: sha256Pattern }),
    response: { type: Schema.Types.Mixed, required: true, immutable: true },
    createdAt: immutableDate,
    expiresAt: immutableDate,
  },
  { ...strictSchemaOptions, collection: "idempotency_keys" },
);
idempotencyKeySchema.index(
  { scope: 1, key: 1 },
  { unique: true, name: "uq_idempotency_scope_key" },
);
idempotencyKeySchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "ttl_idempotency_expiry" },
);

export const complianceScreeningSchema = new Schema(
  {
    screeningId: immutableIdentifier,
    address: immutableAddress,
    normalizedAddress: immutableNormalizedAddress,
    chain: immutableReference("Chain"),
    provider: immutableString({ maxlength: 128 }),
    riskLevel: immutableString({
      enum: ["clear", "low", "medium", "high", "blocked", "unknown"],
    }),
    sanctioned: { type: Boolean, required: true, immutable: true },
    checkedAt: immutableDate,
    rawResponse: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
      select: false,
    },
    providerVersion: immutableString({ maxlength: 128 }),
    listVersion: immutableString({ maxlength: 128 }),
    expiresAt: immutableDate,
  },
  { ...strictSchemaOptions, collection: "compliance_screenings" },
);
complianceScreeningSchema.index(
  { screeningId: 1 },
  { unique: true, name: "uq_compliance_screening_id" },
);
complianceScreeningSchema.index(
  { chain: 1, normalizedAddress: 1, provider: 1, checkedAt: -1 },
  { name: "ix_compliance_address_provider" },
);
complianceScreeningSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "ttl_compliance_cache_expiry" },
);

export const webhookDeliverySchema = new Schema(
  {
    deliveryId: immutableIdentifier,
    merchantId: immutableReference("Merchant"),
    paymentId: immutableReference("Payment"),
    eventType: immutableString({ maxlength: 128 }),
    idempotencyKey: immutableString({ maxlength: 255 }),
    payload: { type: Schema.Types.Mixed, required: true, immutable: true },
    status: {
      type: String,
      required: true,
      enum: ["pending", "delivering", "delivered", "dead_letter"],
    },
    attempts: { ...boundedCounter, default: 0 },
    nextAttemptAt: { type: Date },
    deliveredAt: { type: Date },
    lastResponseCode: { type: Number, min: 100, max: 599 },
    expiresAt: { type: Date },
  },
  { ...timestampOptions, collection: "webhook_deliveries" },
);
webhookDeliverySchema.index(
  { deliveryId: 1 },
  { unique: true, name: "uq_webhook_delivery_id" },
);
webhookDeliverySchema.index(
  { idempotencyKey: 1 },
  { unique: true, name: "uq_webhook_idempotency" },
);
webhookDeliverySchema.index(
  { status: 1, nextAttemptAt: 1 },
  { name: "ix_webhook_delivery_schedule" },
);
webhookDeliverySchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "ttl_webhook_completed" },
);

export const consumedHmacNonceSchema = new Schema(
  {
    keyId: immutableIdentifier,
    nonce: immutableString({ minlength: 16, maxlength: 255 }),
    consumedAt: immutableDate,
    expiresAt: immutableDate,
  },
  { ...strictSchemaOptions, collection: "consumed_hmac_nonces" },
);
consumedHmacNonceSchema.index(
  { keyId: 1, nonce: 1 },
  { unique: true, name: "uq_hmac_key_nonce" },
);
consumedHmacNonceSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "ttl_hmac_nonce_expiry" },
);

export const adminIdentitySchema = new Schema(
  {
    adminId: immutableIdentifier,
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 320,
    },
    passwordHash: { type: String, required: true, select: false, maxlength: 1024 },
    role: { type: String, required: true, enum: ["admin"] },
    status: { type: String, required: true, enum: ["active", "disabled"] },
    tokenVersion: { ...boundedCounter, default: 0 },
    lastAuthenticatedAt: { type: Date },
  },
  { ...timestampOptions, collection: "admin_identities" },
);
adminIdentitySchema.index({ adminId: 1 }, { unique: true, name: "uq_admin_id" });
adminIdentitySchema.index({ email: 1 }, { unique: true, name: "uq_admin_email" });

export const adminSessionSchema = new Schema(
  {
    sessionId: immutableIdentifier,
    adminId: immutableReference("AdminIdentity"),
    refreshTokenHash: {
      type: String,
      required: true,
      immutable: true,
      select: false,
      maxlength: 1024,
    },
    familyId: immutableIdentifier,
    replacedBySessionId: { type: String, match: identifierPattern },
    revokedAt: { type: Date },
    createdAt: immutableDate,
    expiresAt: immutableDate,
  },
  { ...strictSchemaOptions, collection: "admin_sessions" },
);
adminSessionSchema.index(
  { sessionId: 1 },
  { unique: true, name: "uq_admin_session_id" },
);
adminSessionSchema.index(
  { adminId: 1, familyId: 1 },
  { name: "ix_admin_session_family" },
);
adminSessionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "ttl_admin_session_expiry" },
);

export const reconciliationAnnotationSchema = new Schema(
  {
    annotationId: immutableIdentifier,
    entityType: immutableString({
      enum: ["Payment", "OnChainEvent", "ReorgRecord", "ComplianceScreening"],
    }),
    entityId: immutableString({ maxlength: 128 }),
    merchantId: {
      type: String,
      immutable: true,
      match: identifierPattern,
      ref: "Merchant",
    },
    category: immutableString({
      enum: [
        "orphan",
        "stale",
        "late",
        "partial",
        "excess",
        "reorg",
        "compliance",
        "manual_review",
      ],
    }),
    status: { type: String, required: true, enum: ["open", "resolved"] },
    note: immutableString({ maxlength: 4096 }),
    createdBy: immutableString({ maxlength: 128 }),
    createdAt: immutableDate,
    resolvedBy: { type: String, match: identifierPattern },
    resolvedAt: { type: Date },
  },
  { ...strictSchemaOptions, collection: "reconciliation_annotations" },
);
reconciliationAnnotationSchema.index(
  { annotationId: 1 },
  { unique: true, name: "uq_reconciliation_annotation_id" },
);
reconciliationAnnotationSchema.index(
  { status: 1, category: 1, createdAt: 1 },
  { name: "ix_reconciliation_queue" },
);
reconciliationAnnotationSchema.index(
  { entityType: 1, entityId: 1, createdAt: 1 },
  { name: "ix_reconciliation_entity" },
);

export const modelDefinitions = {
  Merchant: merchantSchema,
  MerchantCredential: merchantCredentialSchema,
  MerchantWallet: merchantWalletSchema,
  WalletAddress: walletAddressSchema,
  Payment: paymentSchema,
  Chain: chainSchema,
  Token: tokenSchema,
  OnChainEvent: onChainEventSchema,
  ChainCursor: chainCursorSchema,
  ObservedBlock: observedBlockSchema,
  ReorgRecord: reorgRecordSchema,
  AuditLog: auditLogSchema,
  AuditChainHead: auditChainHeadSchema,
  IdempotencyKey: idempotencyKeySchema,
  ComplianceScreening: complianceScreeningSchema,
  WebhookDelivery: webhookDeliverySchema,
  ConsumedHmacNonce: consumedHmacNonceSchema,
  AdminIdentity: adminIdentitySchema,
  AdminSession: adminSessionSchema,
  ReconciliationAnnotation: reconciliationAnnotationSchema,
} as const;

export type PaymentRecord = InferSchemaType<typeof paymentSchema>;
export type WalletAddressRecord = InferSchemaType<typeof walletAddressSchema>;
export type OnChainEventRecord = InferSchemaType<typeof onChainEventSchema>;
export type AuditLogRecord = InferSchemaType<typeof auditLogSchema>;
export type AuditChainHeadRecord = InferSchemaType<typeof auditChainHeadSchema>;

type PersistenceModels = {
  [Name in keyof typeof modelDefinitions]: Model<
    InferSchemaType<(typeof modelDefinitions)[Name]>
  >;
};

export function registerPersistenceModels(connection: Connection): PersistenceModels {
  return Object.fromEntries(
    Object.entries(modelDefinitions).map(([name, schema]) => [
      name,
      connection.models[name] ?? connection.model(name, schema),
    ]),
  ) as PersistenceModels;
}
