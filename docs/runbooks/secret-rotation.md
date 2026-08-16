# Runbook: Secret rotation (all versioned secrets)

## Principles

- All \*\_CURRENT/\_PREVIOUS pairs validate both keys during rotation, so a
  redeploy never breaks in-flight traffic.
- Source real values from the secrets manager
  (SECRETS_MANAGER_REFERENCE); never commit working credentials.
- Rotate one secret family per maintenance window; verify each step.

## Ingestion HMAC / Webhook signing (platform pairs)

1. Set `*_PREVIOUS_*` to the current values; set `*_CURRENT_*` to the new
   key id + secret (new id MUST differ).
2. Roll API (ingestion verification / webhook signing) and watcher
   (ingestion signing) together — the previous pair bridges the gap.
3. Verify: watcher events accepted (201, not 401); webhooks signed with
   the new key id; receivers verify.
4. Notify merchants before webhook key rotation (they must accept both
   key ids during the window).
5. After ≥1 skew/nonce TTL, remove the previous pair.

## Admin JWT

1. Deploy with PREVIOUS = old current, CURRENT = new (ids must differ).
2. Admin access tokens ≤15 min re-issue under the new key; refresh tokens
   rotate per session with reuse detection.
3. Force logout for a specific admin: bump their tokenVersion (session
   revocation) — no global secret emergency rotation needed.

## Merchant API keys

Merchants self-rotate (new key issued, old revoked after cutover).
Emergency revoke: admin credential deactivate; hashed values only in DB.

## MongoDB / Redis / RPC / screening credentials

Rotate at the provider/infrastructure level, then roll the env and
restart processes (rolling). RPC URLs live only in the env catalog.

## Escalation

On-call + security owner if a secret may have been exposed; treat as a
security incident (incident-response runbook).
