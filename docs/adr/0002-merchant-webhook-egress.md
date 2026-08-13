# ADR 0002: Merchant Webhook Egress Boundary

- Status: Accepted
- Date: 2026-08-13
- Decision owner: Repository owner
- Relates to: `REQ-03A`, `REQ-09`, `REQ-13`

## Context

`prompt.md` prohibits client-controlled RPC URLs and other unsafe outbound
configuration because it would create an SSRF surface. It also requires each
merchant to configure a webhook endpoint that the gateway calls. A webhook URL
is necessarily merchant-controlled outbound input, so treating both categories
identically would make the webhook requirement impossible to implement.

## Decision

RPC endpoints, screening-provider endpoints, secret-manager endpoints, and
other infrastructure destinations remain operator-configured only. No merchant
or unauthenticated client may supply or override them.

A merchant webhook URL is the sole planned v1 client-configured outbound
destination. It is an explicit, narrow exception for the required webhook
feature, not a general-purpose URL-fetching capability. Registration, update,
resolution, connection, redirect handling, and delivery must enforce the Phase
09 SSRF controls, including:

- Merchant authentication, tenant scoping, strict URL parsing, and audit.
- HTTPS-only production destinations, subject to an explicit development-only
  local testing policy.
- Allowed ports and protocols; no embedded credentials or ambiguous parser
  forms.
- DNS resolution and connection checks that block loopback, private,
  link-local, multicast, reserved, and cloud metadata destinations for IPv4 and
  IPv6.
- DNS-rebinding protection by validating all resolved addresses and binding the
  connection to an approved resolution without trusting a later unsafe answer.
- Redirects disabled by default; any allowed redirect is revalidated under the
  complete policy with a small hop limit.
- Bounded connection/read timeouts, response-size limits, concurrency limits,
  and no response-body interpretation beyond safe delivery diagnostics.
- Revalidation on every delivery attempt, because DNS and ownership can change
  after registration.
- Fail-closed rejection or dead-letter handling when destination safety cannot
  be established.

## Consequences

- The general prohibition on client-controlled infrastructure endpoints remains
  intact.
- Webhook delivery is implemented as a dedicated hardened egress component,
  never as a reusable arbitrary fetch/proxy API.
- Webhook secrets, headers, response data, and resolved infrastructure details
  remain redacted from merchant-visible errors and application logs.
- Phase 09 and Phase 12 must include IPv4/IPv6, redirect, DNS rebinding, cloud
  metadata, timeout, and oversized-response SSRF tests.
