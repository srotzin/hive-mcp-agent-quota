# hive-mcp-agent-quota

Per-agent quota meter for the A2A network. Each call to `quota_check`
consumes one or more units against an agent's DID and is settled at
$0.001 USDC per unit on Base L2 via the x402 envelope. Inbound only.
`ENABLE=true` by default.

Brand color: `#C08D23` (Pantone 1245 C, Hive Civilization gold).

## Surface

| Layer | Endpoint | Description |
|---|---|---|
| MCP | `POST /mcp` | JSON-RPC 2.0, Streamable-HTTP, protocol `2024-11-05`. |
| Discovery | `GET /.well-known/mcp.json` | Tool list and transport metadata. |
| REST | `POST /v1/quota/check` | Consume units for a DID. 402 if no balance and no proof. |
| REST | `GET /v1/quota/balance?did=…` | Read remaining quota for a DID. |
| REST | `GET /v1/quota/today` | UTC-day ledger snapshot. |
| REST | `GET /v1/quota/estimate?units=N` | Asking and floor in USDC for N units. |
| Health | `GET /health` | Liveness, pricing, recipient address. |
| Root | `GET /` | HTML for browsers, JSON for agents (Accept-header sniff). JSON-LD `SoftwareApplication`. |

## Tools

| Name | Tier | Cost | Description |
|---|---|---|---|
| `quota_check` | 1 | $0.001/unit | Consume N units for a DID via x402. |
| `quota_balance` | 0 | free | Remaining quota for a DID. |
| `quota_topup_estimate` | 0 | free | Asking and floor for N units. |

## Pricing and the barter floor

Pricing inherits the hivemorph barter pattern. Every 402 envelope advertises
both `amount_usd` (asking) and `accept_min_usd` (floor). A client may submit
a proof whose on-chain paid amount is anywhere in `[floor, asking]` and the
shim accepts it.

Defaults, all overridable by environment variable:

| Variable | Default | Notes |
|---|---|---|
| `QUOTA_CHECK_PRICE_USDC` | `0.001` | Per-unit asking price. |
| `HIVE_X402_FLOOR_PCT_DEFAULT` | `0.70` | Floor as fraction of asking. |
| `HIVE_X402_FLOOR_MIN_PCT` | `0.30` | Hard lower clamp. |
| `HIVE_X402_FLOOR_MAX_PCT` | `0.95` | Hard upper clamp. |

So a 1-unit check at the defaults advertises asking `$0.0010` and accept-min
`$0.0007`. A 100-unit check advertises asking `$0.1000` and accept-min
`$0.0700`. The floor never falls below `MIN_PCT` of asking and never
exceeds `MAX_PCT`.

## Settlement

| Field | Value |
|---|---|
| Chain | Base L2 |
| Asset | USDC |
| Contract | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Recipient | `WALLET_ADDRESS` env, default `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e` |
| Verification | `provider.getTransactionReceipt(tx_hash)` against `BASE_RPC_URL`, decode USDC `Transfer` logs to recipient, sum amount in 6-decimal units, compare to `accept_min_usd`. |
| Signature (optional) | `ethers.verifyMessage(message, signature)` recovers payer; rejected if it disagrees with the on-chain `from`. |

No mocks. The on-chain check is a real RPC read against Base mainnet.

## Storage

SQLite at `QUOTA_DB_PATH` (default `/tmp/quota.db`), three tables:

- `quotas (did, units_purchased, units_consumed, first_seen, last_seen)`
- `checks (id, did, unit_count, granted, remaining, tx_hash, paid_usdc, ts)`
- `topups (id, did, units, paid_usdc, tx_hash UNIQUE, payer, ts)`

`tx_hash` is `UNIQUE` on `topups` to make replay a 409.

## x402 envelope

A `quota_check` call with no prepaid balance and no proof returns:

```json
{
  "error": "payment_required",
  "x402_version": 1,
  "payment": {
    "nonce": "…",
    "amount_usd": 0.001,
    "accept_min_usd": 0.0007,
    "accepts": [{
      "chain": "base",
      "asset": "USDC",
      "contract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "decimals": 6,
      "recipient": "0x15184bf50b3d3f52b60434f8942b7d52f2eb436e",
      "scheme": "exact"
    }],
    "expires_at": 1761600000,
    "tier": 1,
    "product": "agent_quota_check",
    "unit_count": 1,
    "price_per_unit_usd": 0.001,
    "floor_pct": 0.70
  }
}
```

The client sends USDC to the recipient on Base, then resubmits the same
request with an `X-Payment` header containing the proof:

```
X-Payment: {"nonce":"…","chain":"base","tx_hash":"0x…","payer":"0x…","signature":"0x…","message":"hive-quota:<nonce>"}
```

`signature` and `message` are optional. If supplied, the recovered address
must match `payer` and the on-chain `from`.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `ENABLE` | `true` | Set to `false` to disable `tools/call`. |
| `WALLET_ADDRESS` | `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e` | USDC recipient on Base. |
| `QUOTA_CHECK_PRICE_USDC` | `0.001` | Per-unit asking. |
| `HIVE_X402_FLOOR_PCT_DEFAULT` | `0.70` | |
| `HIVE_X402_FLOOR_MIN_PCT` | `0.30` | |
| `HIVE_X402_FLOOR_MAX_PCT` | `0.95` | |
| `BASE_RPC_URL` | `https://mainnet.base.org` | |
| `DEFAULT_QUOTA_UNITS` | `0` | Free units credited on first sight of a DID. |
| `QUOTA_DB_PATH` | `/tmp/quota.db` | |

## Running locally

```
npm install
node server.js
```

Then:

```
curl -s http://localhost:3000/health
curl -s -X POST http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s 'http://localhost:3000/v1/quota/today'
```

## Hard rules

- Inbound only. The shim never originates an outbound payment.
- No private key in the repo. Verification is read-only.
- No custody. The recipient address belongs to the operator, not the shim.
- Returns are advisory until the on-chain receipt is confirmed by `BASE_RPC_URL`.

## Council provenance

Tier A position 3. 2026-04-27. Inbound metering surface, symmetric to
[hive-mcp-barter](https://github.com/srotzin/hive-mcp-barter) (outbound
counter-offer) and [hive-mcp-auction](https://github.com/srotzin/hive-mcp-auction)
(inbound reverse-Dutch).

## License

MIT. See `LICENSE`.
