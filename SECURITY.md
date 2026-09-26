# MerchantDesk security boundaries

MerchantDesk is a local/authorized-team demo workbench built on Craft Agents. It is not a hardened multi-tenant commerce service.

## Commerce tools

- Runtime `SessionToolContext` determines workspace and session identity; model inputs cannot override them.
- Administrator-managed grants specify roles, order IDs, expiry and the cumulative refund budget. Grants are not created through an agent tool.
- Refunds validate integer CNY cents, remaining paid amount, role and budget. Idempotency is scoped to workspace/session/request ID. Inventory uses expected versions and rejects invalid stock.
- Writes use a cross-process lock and a durable JSONL append. Invalid interior ledger records fail closed. Stale locks require administrator inspection.
- The demo never contacts a payment processor. Production integrations must enforce equivalent authorization and idempotency at the remote business service.

## Trust model

Local administrators, filesystem access, shell tools and the shared server token can bypass local grant files. Session grants protect the commerce API boundary, not the operating system. Do not expose this server to mutually untrusted customers or merchants. Use a separate authenticated business service, per-tenant credentials, OS isolation and database transactions for production.

Explore mode blocks commerce mutations. Ask/Auto preserve upstream permission semantics; changing mode does not expand commerce grants. Prompt guidance is not an authorization control.

Execution audit copies omit raw tool arguments, raw results and permission commands. Conversation transcripts and text events may still contain customer data. Apply retention/access policies and never commit runtime workspaces, credentials, logs or real customer records. Do not edit seed data after transactions have started; it is the immutable basis of ledger replay.

## Reporting

Report MerchantDesk-specific vulnerabilities through this repository's private GitHub security reporting channel when enabled. If private reporting is unavailable, open a minimal issue requesting a private contact, without exploit details, secrets or customer data. This fork does not promise a fixed response SLA and does not route reports to Craft's support addresses. Report upstream-only issues to the relevant upstream maintainers.
