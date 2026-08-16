# Compliance Statement — Oscar Payment Gateway

This document describes what the compliance controls in this system do and,
explicitly, what they do **not** do. It is engineering documentation, not
legal advice.

## This software is not a compliance program

Oscar implements screening and review **hooks** that a compliance program can
use. Shipping, configuring, and operating this software does not by itself
satisfy any legal, regulatory, or licensing obligation anywhere. Licensing,
Suspicious Activity Report (SAR) filing, customer due diligence, governance,
training, and record-retention decisions require qualified,
jurisdiction-specific legal counsel before processing real funds.

## Regulatory classification is uncertain

Whether an operator of a non-custodial crypto payment gateway is a Money
Services Business (MSB) under FinCEN rules, a Virtual Asset Service Provider
(VASP) under FATF-aligned national regimes, or entirely outside a licensing
perimeter depends on the operator's activities, custody posture, geography,
and customers. This system deliberately never holds merchant private keys
(non-custodial receiving), which one jurisdiction may treat as outside
custody regulation and another may not. Classification must be assessed by
counsel per deployment.

## Sanctions screening

- The system screens the merchant receiving address at payment creation and
  the observed sender before any payment reaches `confirmed`.
- Screening verdicts are fail-closed: `blocked`, `unavailable`, and
  `indeterminate` results hold payments. No code path treats an error or an
  unknown result as approval.
- The updateable sanctions-list fallback (`managed-list` provider) is a
  minimal address-list checker — it is **not** an OFAC-certified screening
  product. It does not implement entity/name matching, fuzzy matching,
  ownership heuristics, or multi-jurisdiction lists. Operators with real
  screening obligations should integrate a dedicated provider
  (Chainalysis, TRM Labs, Elliptic, or equivalent) behind the same
  `SanctionsScreeningProvider` interface and legal review.
- Managed lists carry provenance (version, source, content hash, entry
  count) and fail closed when stale (`SCREENING_LIST_MAX_AGE_SEC`).
- Every screening call is recorded (`ComplianceScreening`) with provider,
  time, risk, list version, and a raw provider response excluded from
  default query projections.
- Human review decisions are append-only, attributed to an administrator,
  audited, and required before a held payment can progress. A `release`
  decision is an operational override, not a legal determination.

## FATF Travel Rule

The Travel Rule (originator/beneficiary information accompanying covered
virtual-asset transfers) may apply depending on the operator's
classification and the counterparties. This system records sender and
recipient addresses on-chain data and payment records, but it does **not**
implement Travel Rule messaging (IVMS 101 exchanges), counterparty VASP
discovery, or required-information validation. Operators subject to the
Travel Rule need additional components and counsel review.

## Recordkeeping

Payment, event, screening, review, and audit records are retained with
append-only audit chaining. Note that `ComplianceScreening` records are
cache-scoped with a TTL (they expire); durable evidence of review outcomes
lives in `ComplianceReview`, `AuditLog`, and payment annotations. Operators
with statutory retention periods must export or archive accordingly and
should confirm retention scope with counsel.

## Required before operating with real funds

1. Jurisdiction-specific legal review (MSB/VASP classification, licensing,
   sanctions obligations, Travel Rule applicability).
2. A managed screening-list update process (or integrated screening
   provider) with freshness monitoring — a stale list holds all payments by
   design.
3. Documented review-decision procedures and personnel for the holds queue.
4. Retention and reporting arrangements meeting the operator's statutory
   obligations.
