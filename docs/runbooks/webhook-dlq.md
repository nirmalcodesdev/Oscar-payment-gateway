# Runbook: Webhook dead-letter queue

## Detection

- Alert `OscarWebhookDeadLetter` (oscar_webhook_dead_letter > 0).

## Actions

1. Open reconciliation → webhook dead letters (attempts, last response
   code).
2. Diagnose by response code:
   - 4xx (except 429): receiver rejects — confirm with the merchant;
     likely payload/endpoint change. Do not blindly replay.
   - 5xx/timeout/network: receiver outage — retry after recovery.
   - No code: destination unreachable/invalid; verify the merchant's
     registered URL.
3. After fixing the cause: `POST /api/v1/admin/webhooks/:deliveryId/replay`
   (audited) resets and re-enqueues. Deliveries are at-least-once;
   receivers must deduplicate on delivery id.
4. Chronic failures → merchant updates their webhook URL (step-up auth)
   and old dead letters are resolved via annotation with a note.

## Escalation

On-call → merchant support owner.
