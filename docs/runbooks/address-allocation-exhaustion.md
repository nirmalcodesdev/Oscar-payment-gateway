# Runbook: Deposit address allocation exhaustion

## Detection

- API error log "Deposit address allocation space exhausted" per wallet;
  payment creation fails closed (503) without allocating or advancing the
  index.

## Impact

New payments for that merchant's wallet fail; existing payments are
unaffected.

## Actions

1. Confirm scope: which merchant/wallet (log merchantId + chain).
2. Cause is always a hardened/unhardened derivation-index limit on the
   registered xpub for that chain.
3. Remediation (with the merchant, via step-up authenticated flow):
   - Register a new wallet (new xpub) — new allocations use it.
   - Existing open payments keep their addresses; they resolve normally.
4. Never reset or reuse derivation indexes; addresses are per-payment
   forever (Option A).

## Escalation

Merchant support → engineering lead.
