# hive-mcp-agent-quota — v1.0.0

**Date:** 2026-04-27
**Council provenance:** Tier A position 3, ad-hoc user-promoted.

## Summary

Per-agent quota meter for the A2A network. Each `quota_check` consumes one
or more units against an agent DID, settled at $0.001 USDC per unit on
Base L2 via the x402 envelope. Inbound only. `ENABLE=true` by default.

Inbound metering surface, symmetric to `hive-mcp-barter` (outbound
counter-offer) and `hive-mcp-auction` (inbound reverse-Dutch).

## Tools

| Name | Tier | Cost | Description |
|---|---|---|---|
| `quota_check` | 1 | $0.001 USDC per unit | Consume N units for a DID via x402. Returns 402 if no balance and no inline proof; resubmit with `X-Payment`. |
| `quota_balance` | 0 | free | Read remaining quota for a DID. |
| `quota_topup_estimate` | 0 | free | Asking and floor in USDC for N units. |

## REST endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/quota/check` | Consume units. 402 envelope on no-balance / no-proof. |
| `GET` | `/v1/quota/balance` | Remaining quota for a DID. |
| `GET` | `/v1/quota/today` | UTC-day ledger snapshot, including recent checks and topups. |
| `GET` | `/v1/quota/estimate` | Asking and floor for N units. |
| `GET` | `/health` | Liveness, pricing, recipient address. |
| `GET` | `/` | HTML for browsers (brand gold), JSON for agents (Accept sniff). JSON-LD `SoftwareApplication`. |
| `GET` | `/.well-known/mcp.json` | Tool list and transport metadata. |

## Pricing model — barter floor inheritance

Every 402 envelope advertises both `amount_usd` (asking) and `accept_min_usd`
(floor), inheriting the hivemorph `hive_x402/barter.py` defaults:

- `HIVE_X402_FLOOR_PCT_DEFAULT = 0.70`
- `HIVE_X402_FLOOR_MIN_PCT = 0.30`
- `HIVE_X402_FLOOR_MAX_PCT = 0.95`

A proof whose on-chain paid amount lies anywhere in `[floor, asking]` is
accepted. A 1-unit check defaults to asking `$0.0010` / floor `$0.0007`.

## Persistence

SQLite at `/tmp/quota.db` (overridable via `QUOTA_DB_PATH`):

- `quotas (did, units_purchased, units_consumed, first_seen, last_seen)`
- `checks (id, did, unit_count, granted, remaining, tx_hash, paid_usdc, ts)`
- `topups (id, did, units, paid_usdc, tx_hash UNIQUE, payer, ts)`

`tx_hash` is `UNIQUE` on `topups`; replays return 409.

## Real rails

- **SQLite:** `better-sqlite3`, WAL journal, transactional topup-and-credit.
- **ethers:** `ethers.verifyMessage(message, signature)` recovers the payer
  address; rejected on disagreement with `payer` or with the on-chain `from`.
- **Base RPC:** `JsonRpcProvider(BASE_RPC_URL)` reads
  `getTransactionReceipt(tx_hash)`, decodes USDC `Transfer` logs to the
  configured recipient, sums amount in 6-decimal units, compares to
  `accept_min_usd`. No mocks.

## Brand

Hive Civilization gold `#C08D23` (Pantone 1245 C). Verified — no
`#f5c518` anywhere in the repo. HTML root, JSON, JSON-LD, smithery
manifest, and README all reference the same hex.

## Settlement

USDC on Base L2, contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`,
to the wallet at `WALLET_ADDRESS` (default `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`,
the W1 MONROE recipient). The shim holds no signing key, originates no
outbound transfer, and reads chain state through a public RPC.

## What this build is not

- Not an outbound buyer.
- Not a custodian.
- Not a credit issuer — quota is prepaid in USDC and consumed.
- Not a price oracle — `quota_topup_estimate` is advisory, derived from the
  configured asking price and floor band.

## Smoke

- `GET /health` → `200`, includes `price_per_unit_usd`, `floor_pct`, recipient.
- `POST /mcp tools/list` → 3 tools (`quota_check`, `quota_balance`, `quota_topup_estimate`).
- `GET /v1/quota/today` → `200`, empty ledger initially.
- Invalid DID on `/v1/quota/check` → `400 invalid_did`.
- `quota_check` against a DID with zero balance and no `X-Payment` →
  402 envelope with `accept_min_usd < amount_usd`.
