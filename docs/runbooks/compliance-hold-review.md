# Runbook: Compliance hold review

## Detection

- Reconciliation view "compliance holds"; alert `OscarComplianceHolds`
  when accumulation exceeds threshold.

## Actions

1. Open `GET /api/v1/admin/compliance/holds` (admin JWT required).
2. For each held payment inspect the latest screening record and the
   current sanctions list version. NEVER resolve a hold by editing the
   database.
3. Decide per payment:
   - List updated and address now clear → wait for the screening recheck
     (or ingest a corrected list); the hold clears automatically.
   - Sanctioned → record a `block` review decision (pins the hold) and
     follow the compliance program's escalation (counsel; regulator
     reporting as applicable — see COMPLIANCE.md).
   - Confirmed false positive with documented evidence → record a
     `release` decision with reason and evidence; this is an audited
     operational override, not a legal determination.
4. Every decision is written to the append-only audit chain and the
   compliance review collection with the reviewing admin as actor.

## Escalation

Compliance officer → qualified counsel. System operators must not make
sanctions determinations.
