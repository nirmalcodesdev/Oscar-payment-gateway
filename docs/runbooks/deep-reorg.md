# Runbook: Deep reorg / finality incident

## Detection

- Error log `p1_finality_incident` (severity P1) and alert
  `OscarDeepReorg` (increase in oscar_reorg_records_total).
- Affected confirmed payments have `automationHold: true`.

## Impact

A reorg deeper than a payment's snapshotted confirmations orphaned events
that had already confirmed. Terminal history is preserved; automation is
held pending human decision. Non-terminal payments wait for replacements
until expiry+grace, then fail safely.

## Actions (P1 — begin immediately)

1. Confirm scope: `ReorgRecord` (fromBlock/toBlock, orphanedTxHashes,
   affectedPaymentIds) and payments with `automationHold: true`.
2. Corroborate the reorg through ≥2 independent providers and a block
   explorer; never trust one source.
3. For each held payment decide, with compliance/finance sign-off:
   - Transaction re-included on the new chain → document and record the
     disposition via an audited admin decision.
   - Transaction gone → the historical confirmation stands as recorded;
     reconcile the merchant credit through the finance process.
4. Do NOT clear `automationHold` via direct database writes; only the
   audited manual disposition path may release automation.
5. Review `requiredConfirmations` for the chain; deep reorgs indicate the
   configured depth was too shallow. Adjust via the registry (affects only
   new payments).

## Escalation

P1 page → engineering lead + finance owner. Timeline preserved via the
append-only audit chain.
