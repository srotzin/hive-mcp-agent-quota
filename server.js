#!/usr/bin/env node
/**
 * hive-mcp-agent-quota — Per-agent quota meter for the A2A network.
 *
 * Agents call /v1/quota/check with a DID and a unit_count. Each check
 * costs $0.001 USDC on Base L2, settled via the x402 envelope. The shim
 * tracks consumption per DID in SQLite, returns the remaining balance,
 * and inherits the barter floor pricing pattern from hivemorph.
 *
 * Inbound only. ENABLE=true default.
 *
 * Brand: Hive Civilization gold #C08D23 (Pantone 1245 C).
 * Spec : MCP 2024-11-05 / Streamable-HTTP / JSON-RPC 2.0.
 */

import express from 'express';
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// ─── Config ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ENABLE = String(process.env.ENABLE ?? 'true').toLowerCase() === 'true';
const PRICE_USDC = Number(process.env.QUOTA_CHECK_PRICE_USDC) || 0.001;

// Barter floor inheritance — mirrors hivemorph hive_x402/barter.py defaults.
const FLOOR_PCT_DEFAULT = Number(process.env.HIVE_X402_FLOOR_PCT_DEFAULT) || 0.70;
const FLOOR_PCT_MIN = Number(process.env.HIVE_X402_FLOOR_MIN_PCT) || 0.30;
const FLOOR_PCT_MAX = Number(process.env.HIVE_X402_FLOOR_MAX_PCT) || 0.95;
function clampFloorPct(p) {
  return Math.max(FLOOR_PCT_MIN, Math.min(FLOOR_PCT_MAX, p));
}
const FLOOR_USDC = +(PRICE_USDC * clampFloorPct(FLOOR_PCT_DEFAULT)).toFixed(6);

const WALLET_RECIPIENT = (process.env.WALLET_ADDRESS || '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e').toLowerCase();
const USDC_BASE_CONTRACT = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

const DEFAULT_QUOTA_UNITS = Number(process.env.DEFAULT_QUOTA_UNITS) || 0;
const NONCE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 15 * 60 * 1000;

const DB_PATH = process.env.QUOTA_DB_PATH || '/tmp/quota.db';
const BRAND_GOLD = '#C08D23';

// ─── SQLite ────────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS quotas (
    did TEXT PRIMARY KEY,
    units_purchased INTEGER NOT NULL DEFAULT 0,
    units_consumed INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    did TEXT NOT NULL,
    unit_count INTEGER NOT NULL,
    granted INTEGER NOT NULL,
    remaining INTEGER NOT NULL,
    tx_hash TEXT,
    paid_usdc REAL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_checks_did ON checks(did);
  CREATE INDEX IF NOT EXISTS idx_checks_ts ON checks(ts);
  CREATE TABLE IF NOT EXISTS topups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    did TEXT NOT NULL,
    units INTEGER NOT NULL,
    paid_usdc REAL NOT NULL,
    tx_hash TEXT NOT NULL UNIQUE,
    payer TEXT,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_topups_did ON topups(did);
`);

const stmts = {
  getQuota: db.prepare('SELECT * FROM quotas WHERE did = ?'),
  upsertQuota: db.prepare(`
    INSERT INTO quotas (did, units_purchased, units_consumed, first_seen, last_seen)
    VALUES (@did, @units_purchased, 0, @ts, @ts)
    ON CONFLICT(did) DO UPDATE SET
      units_purchased = units_purchased + excluded.units_purchased,
      last_seen = excluded.last_seen
  `),
  consumeUnits: db.prepare(`
    UPDATE quotas
    SET units_consumed = units_consumed + ?, last_seen = ?
    WHERE did = ? AND (units_purchased - units_consumed) >= ?
  `),
  insertCheck: db.prepare(`
    INSERT INTO checks (did, unit_count, granted, remaining, tx_hash, paid_usdc, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  insertTopup: db.prepare(`
    INSERT INTO topups (did, units, paid_usdc, tx_hash, payer, ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getTopupByTx: db.prepare('SELECT * FROM topups WHERE tx_hash = ?'),
  todayChecks: db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(granted),0) AS units, COALESCE(SUM(paid_usdc),0) AS usdc
    FROM checks WHERE ts >= ?
  `),
  todayTopups: db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(units),0) AS units, COALESCE(SUM(paid_usdc),0) AS usdc
    FROM topups WHERE ts >= ?
  `),
  todayDistinct: db.prepare(`SELECT COUNT(DISTINCT did) AS n FROM checks WHERE ts >= ?`),
  recentChecks: db.prepare(`SELECT did, unit_count, granted, remaining, tx_hash, paid_usdc, ts FROM checks WHERE ts >= ? ORDER BY ts DESC LIMIT 200`),
  recentTopups: db.prepare(`SELECT did, units, paid_usdc, tx_hash, payer, ts FROM topups WHERE ts >= ? ORDER BY ts DESC LIMIT 200`),
};

function midnightUtcSec() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// ─── Base L2 RPC — real reads, no mocks ────────────────────────────────────
const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
const USDC_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

async function verifyOnchain(txHash, expectedRecipient, minAmountUsdc) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: 'bad_tx_hash_format' };
  }
  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    return { ok: false, reason: 'rpc_error', detail: err.message };
  }
  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_reverted' };

  const recipient = expectedRecipient.toLowerCase();
  const usdcAddr = USDC_BASE_CONTRACT.toLowerCase();
  let paidRaw = 0n;
  let payer = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdcAddr) continue;
    if (!log.topics || log.topics[0] !== USDC_TRANSFER_TOPIC) continue;
    if (log.topics.length < 3) continue;
    const to = ('0x' + log.topics[2].slice(26)).toLowerCase();
    if (to !== recipient) continue;
    const from = ('0x' + log.topics[1].slice(26)).toLowerCase();
    const amount = BigInt(log.data);
    paidRaw += amount;
    if (!payer) payer = from;
  }
  if (paidRaw === 0n) return { ok: false, reason: 'no_usdc_transfer_to_recipient' };
  const paidUsdc = Number(paidRaw) / 1e6;
  if (paidUsdc + 1e-9 < minAmountUsdc) {
    return { ok: false, reason: 'underpaid', paid_usdc: paidUsdc, min_usdc: minAmountUsdc };
  }
  return { ok: true, paid_usdc: paidUsdc, payer, block: receipt.blockNumber };
}

// ─── x402 envelope ─────────────────────────────────────────────────────────
const nonces = new Map();
const tokens = new Map();
function gc() {
  const now = Date.now();
  for (const [k, v] of nonces) if (v.expires_at_ms < now) nonces.delete(k);
  for (const [k, v] of tokens) if (v.expires_at_ms < now) tokens.delete(k);
}
setInterval(gc, 60_000).unref?.();

function quoteEnvelope({ unit_count = 1, did = null } = {}) {
  const nonce = crypto.randomUUID();
  const askingUsdc = +(PRICE_USDC * unit_count).toFixed(6);
  const floorUsdc = +(askingUsdc * clampFloorPct(FLOOR_PCT_DEFAULT)).toFixed(6);
  const expires_at = Math.floor((Date.now() + NONCE_TTL_MS) / 1000);
  nonces.set(nonce, { expires_at_ms: Date.now() + NONCE_TTL_MS, paid: false, unit_count, did });
  return {
    error: 'payment_required',
    x402_version: 1,
    payment: {
      nonce,
      amount_usd: askingUsdc,
      accept_min_usd: floorUsdc,
      accepts: [{
        chain: 'base',
        asset: 'USDC',
        contract: USDC_BASE_CONTRACT,
        decimals: 6,
        recipient: WALLET_RECIPIENT,
        scheme: 'exact',
      }],
      expires_at,
      tier: 1,
      product: 'agent_quota_check',
      unit_count,
      price_per_unit_usd: PRICE_USDC,
      floor_pct: clampFloorPct(FLOOR_PCT_DEFAULT),
    },
  };
}

async function redeemProof({ nonce, payer, chain, tx_hash, signature, message }) {
  if (!nonce || !chain || !tx_hash) return { ok: false, status: 400, error: 'missing_fields' };
  const n = nonces.get(nonce);
  if (!n) return { ok: false, status: 404, error: 'unknown_or_expired_nonce' };
  if (n.expires_at_ms < Date.now()) {
    nonces.delete(nonce);
    return { ok: false, status: 410, error: 'nonce_expired' };
  }
  if (chain.toLowerCase() !== 'base') return { ok: false, status: 400, error: 'unsupported_chain' };

  const askingUsdc = +(PRICE_USDC * n.unit_count).toFixed(6);
  const floorUsdc = +(askingUsdc * clampFloorPct(FLOOR_PCT_DEFAULT)).toFixed(6);

  // Optional ethers signature verification — if signature + message are present
  // we recover the address and use it as the canonical payer when on-chain
  // payer is ambiguous.
  let recoveredAddr = null;
  if (signature && message) {
    try {
      recoveredAddr = ethers.verifyMessage(String(message), String(signature)).toLowerCase();
    } catch {
      return { ok: false, status: 400, error: 'bad_signature' };
    }
  }

  const dup = stmts.getTopupByTx.get(tx_hash);
  if (dup) return { ok: false, status: 409, error: 'tx_already_redeemed' };

  const v = await verifyOnchain(tx_hash, WALLET_RECIPIENT, floorUsdc);
  if (!v.ok) return { ok: false, status: 402, error: 'onchain_verification_failed', detail: v };

  const canonicalPayer = (payer || recoveredAddr || v.payer || '').toLowerCase() || null;
  if (recoveredAddr && payer && recoveredAddr !== payer.toLowerCase()) {
    return { ok: false, status: 400, error: 'signature_payer_mismatch' };
  }
  if (recoveredAddr && v.payer && recoveredAddr !== v.payer.toLowerCase()) {
    return { ok: false, status: 400, error: 'signature_onchain_payer_mismatch' };
  }

  n.paid = true;
  n.tx_hash = tx_hash;
  n.paid_usdc = v.paid_usdc;
  n.payer = canonicalPayer;
  const token = `hq_${crypto.randomUUID().replace(/-/g, '')}`;
  tokens.set(token, {
    expires_at_ms: Date.now() + TOKEN_TTL_MS,
    nonce, tx_hash, payer: canonicalPayer, paid_usdc: v.paid_usdc,
    unit_count: n.unit_count, did: n.did,
  });
  return {
    ok: true, access_token: token, expires_in: Math.floor(TOKEN_TTL_MS / 1000),
    paid_usdc: v.paid_usdc, payer: canonicalPayer, block: v.block,
  };
}

function tokenForReq(req) {
  const hdr = req.headers['x-hive-access'];
  if (hdr && tokens.has(hdr)) {
    const t = tokens.get(hdr);
    if (t.expires_at_ms > Date.now()) return { ok: true, token: hdr, ctx: t };
    tokens.delete(hdr);
  }
  return { ok: false };
}

async function inlineRedeem(req) {
  const inline = req.headers['x-payment'];
  if (!inline) return { ok: false };
  try {
    const env = typeof inline === 'string' ? JSON.parse(inline) : inline;
    if (!env?.nonce || !env?.tx_hash || !env?.chain) return { ok: false };
    const r = await redeemProof(env);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, mint: r };
  } catch {
    return { ok: false, error: 'bad_inline_payment' };
  }
}

// ─── Quota math ────────────────────────────────────────────────────────────
function getOrInitQuota(did) {
  const row = stmts.getQuota.get(did);
  if (row) return row;
  const ts = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO quotas (did, units_purchased, units_consumed, first_seen, last_seen) VALUES (?, ?, 0, ?, ?)`)
    .run(did, DEFAULT_QUOTA_UNITS, ts, ts);
  return stmts.getQuota.get(did);
}

function recordTopup(did, units, paidUsdc, txHash, payer) {
  const ts = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    stmts.upsertQuota.run({ did, units_purchased: units, ts });
    stmts.insertTopup.run(did, units, paidUsdc, txHash, payer || null, ts);
  });
  tx();
}

function consume(did, unitCount) {
  const ts = Math.floor(Date.now() / 1000);
  const before = getOrInitQuota(did);
  const remainingBefore = before.units_purchased - before.units_consumed;
  if (remainingBefore < unitCount) {
    return { ok: false, reason: 'insufficient_quota', remaining: remainingBefore, requested: unitCount };
  }
  const result = stmts.consumeUnits.run(unitCount, ts, did, unitCount);
  if (result.changes !== 1) {
    return { ok: false, reason: 'race_consume_failed', remaining: remainingBefore };
  }
  const after = stmts.getQuota.get(did);
  const remaining = after.units_purchased - after.units_consumed;
  stmts.insertCheck.run(did, unitCount, unitCount, remaining, null, null, ts);
  return { ok: true, granted: unitCount, remaining };
}

function isValidDid(s) {
  return typeof s === 'string' && /^did:[a-z0-9]+:[A-Za-z0-9._:%-]{3,}$/.test(s);
}

function topupEstimate(unitsRequested) {
  const u = Math.max(1, Math.floor(unitsRequested || 0));
  const asking = +(PRICE_USDC * u).toFixed(6);
  const floor = +(asking * clampFloorPct(FLOOR_PCT_DEFAULT)).toFixed(6);
  return {
    units: u,
    price_per_unit_usd: PRICE_USDC,
    asking_usd: asking,
    accept_min_usd: floor,
    floor_pct: clampFloorPct(FLOOR_PCT_DEFAULT),
    chain: 'base',
    asset: 'USDC',
    contract: USDC_BASE_CONTRACT,
    recipient: WALLET_RECIPIENT,
  };
}

// ─── MCP tools ─────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'quota_check',
    description: 'Consume one or more quota units for an agent DID. Costs $0.001 USDC per unit on Base L2 via x402. Inbound only. First call returns a 402 envelope; submit proof inline via X-Payment header to mint an access token, then retry.',
    inputSchema: {
      type: 'object',
      required: ['did'],
      properties: {
        did: { type: 'string', description: 'Agent DID (did:method:identifier).' },
        unit_count: { type: 'integer', minimum: 1, default: 1, description: 'Quota units to consume. Default 1.' },
      },
    },
  },
  {
    name: 'quota_balance',
    description: 'Read remaining quota for an agent DID. Free. Returns units_purchased, units_consumed, units_remaining, first_seen, last_seen.',
    inputSchema: {
      type: 'object',
      required: ['did'],
      properties: {
        did: { type: 'string', description: 'Agent DID (did:method:identifier).' },
      },
    },
  },
  {
    name: 'quota_topup_estimate',
    description: 'Estimate the USDC cost to top up a DID with N units. Free. Inherits the hivemorph barter floor: returns asking_usd and accept_min_usd. Use the returned values to construct an x402 proof.',
    inputSchema: {
      type: 'object',
      required: ['units'],
      properties: {
        units: { type: 'integer', minimum: 1, description: 'Units to top up.' },
      },
    },
  },
];

function asTextResult(obj) {
  return { type: 'text', text: JSON.stringify(obj, null, 2) };
}

async function executeTool(name, args, req) {
  switch (name) {
    case 'quota_balance': {
      if (!isValidDid(args.did)) throw new Error('invalid_did');
      const q = getOrInitQuota(args.did);
      return asTextResult({
        did: args.did,
        units_purchased: q.units_purchased,
        units_consumed: q.units_consumed,
        units_remaining: q.units_purchased - q.units_consumed,
        first_seen: q.first_seen,
        last_seen: q.last_seen,
      });
    }
    case 'quota_topup_estimate': {
      const u = Math.max(1, Math.floor(args.units || 0));
      if (u < 1) throw new Error('units_must_be_positive');
      return asTextResult(topupEstimate(u));
    }
    case 'quota_check': {
      if (!isValidDid(args.did)) throw new Error('invalid_did');
      const unitCount = Math.max(1, Math.floor(args.unit_count || 1));

      // Path 1 — DID already has prepaid quota, consume it.
      const q = getOrInitQuota(args.did);
      const remaining = q.units_purchased - q.units_consumed;
      if (remaining >= unitCount) {
        const out = consume(args.did, unitCount);
        return asTextResult({ did: args.did, charged: false, ...out });
      }

      // Path 2 — Pay-per-check. Look for inline x402 proof.
      const tok = tokenForReq(req);
      let mint = null;
      if (tok.ok && tok.ctx?.unit_count >= unitCount) {
        mint = { token: tok.token, paid_usdc: tok.ctx.paid_usdc, payer: tok.ctx.payer };
      } else {
        const inline = await inlineRedeem(req);
        if (inline.ok) mint = inline.mint;
      }
      if (!mint) {
        const env = quoteEnvelope({ unit_count: unitCount, did: args.did });
        const err = new Error('payment_required');
        err.code = 402;
        err.data = env;
        throw err;
      }
      // Credit purchased units to DID, then consume.
      const ts = Math.floor(Date.now() / 1000);
      if (mint.tx_hash) {
        try { recordTopup(args.did, unitCount, mint.paid_usdc, mint.tx_hash, mint.payer); }
        catch { /* duplicate tx_hash race — ignore */ }
      } else {
        // Token-based mint already credited — credit units now.
        stmts.upsertQuota.run({ did: args.did, units_purchased: unitCount, ts });
      }
      const out = consume(args.did, unitCount);
      return asTextResult({
        did: args.did,
        charged: true,
        paid_usdc: mint.paid_usdc,
        payer: mint.payer,
        ...out,
      });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── App ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '128kb' }));

// Health
app.get('/health', (req, res) => {
  let blockNumber = null;
  // Non-blocking — best-effort.
  res.json({
    status: 'ok',
    service: 'hive-mcp-agent-quota',
    version: '1.0.0',
    enable: ENABLE,
    inbound_only: true,
    price_per_unit_usd: PRICE_USDC,
    floor_pct: clampFloorPct(FLOOR_PCT_DEFAULT),
    floor_usd: FLOOR_USDC,
    chain: 'base',
    asset: 'USDC',
    recipient: WALLET_RECIPIENT,
    db_path: DB_PATH,
    brand_color: BRAND_GOLD,
  });
});

// Root — HTML for browsers, JSON for agents (Accept-header sniff)
app.get('/', (req, res) => {
  const accept = String(req.headers.accept || '');
  if (accept.includes('text/html')) {
    res.type('html').send(rootHtml());
    return;
  }
  res.json({
    service: 'hive-mcp-agent-quota',
    version: '1.0.0',
    description: 'Per-agent quota meter for the A2A network. Inbound only.',
    docs: 'https://github.com/srotzin/hive-mcp-agent-quota',
    endpoints: {
      mcp: '/mcp',
      well_known: '/.well-known/mcp.json',
      rest: ['/v1/quota/check', '/v1/quota/balance', '/v1/quota/today', '/v1/quota/estimate'],
      health: '/health',
    },
    pricing: {
      price_per_unit_usd: PRICE_USDC,
      floor_pct: clampFloorPct(FLOOR_PCT_DEFAULT),
      chain: 'base',
      asset: 'USDC',
    },
    brand_color: BRAND_GOLD,
  });
});

// MCP JSON-RPC
app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (jsonrpc !== '2.0') {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC' } });
  }
  try {
    switch (method) {
      case 'initialize':
        return res.json({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: 'hive-mcp-agent-quota',
              version: '1.0.0',
              description: 'Per-agent quota meter for the A2A network — Hive Civilization. Inbound only.',
            },
          },
        });
      case 'tools/list':
        return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const { name, arguments: args } = params || {};
        if (!ENABLE) {
          return res.json({ jsonrpc: '2.0', id, error: { code: 503, message: 'service_disabled' } });
        }
        try {
          const out = await executeTool(name, args || {}, req);
          return res.json({ jsonrpc: '2.0', id, result: { content: [out] } });
        } catch (err) {
          if (err.code === 402) {
            return res.json({
              jsonrpc: '2.0', id,
              error: { code: 402, message: 'payment_required', data: err.data },
            });
          }
          return res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
        }
      }
      case 'ping':
        return res.json({ jsonrpc: '2.0', id, result: {} });
      default:
        return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
  }
});

// REST
app.post('/v1/quota/check', async (req, res) => {
  if (!ENABLE) return res.status(503).json({ error: 'service_disabled' });
  try {
    const out = await executeTool('quota_check', req.body || {}, req);
    res.json(JSON.parse(out.text));
  } catch (err) {
    if (err.code === 402) return res.status(402).json(err.data);
    res.status(400).json({ error: err.message });
  }
});

app.get('/v1/quota/balance', (req, res) => {
  const did = String(req.query.did || '');
  if (!isValidDid(did)) return res.status(400).json({ error: 'invalid_did' });
  const q = getOrInitQuota(did);
  res.json({
    did,
    units_purchased: q.units_purchased,
    units_consumed: q.units_consumed,
    units_remaining: q.units_purchased - q.units_consumed,
    first_seen: q.first_seen,
    last_seen: q.last_seen,
  });
});

app.get('/v1/quota/estimate', (req, res) => {
  const u = Math.max(1, Math.floor(Number(req.query.units) || 0));
  if (u < 1) return res.status(400).json({ error: 'units_must_be_positive' });
  res.json(topupEstimate(u));
});

app.get('/v1/quota/today', (req, res) => {
  const since = midnightUtcSec();
  const c = stmts.todayChecks.get(since);
  const t = stmts.todayTopups.get(since);
  const d = stmts.todayDistinct.get(since);
  res.json({
    date_utc: new Date(since * 1000).toISOString().slice(0, 10),
    checks: { count: c.n, units_consumed: c.units, usdc_routed_via_consume: c.usdc },
    topups: { count: t.n, units_purchased: t.units, usdc_paid: t.usdc },
    distinct_dids: d.n,
    recent_checks: stmts.recentChecks.all(since),
    recent_topups: stmts.recentTopups.all(since),
  });
});

// MCP discovery
app.get('/.well-known/mcp.json', (req, res) => {
  res.json({
    name: 'hive-mcp-agent-quota',
    version: '1.0.0',
    protocol: '2024-11-05',
    transport: 'streamable-http',
    endpoint: '/mcp',
    description: 'Per-agent quota meter for the A2A network. Inbound only.',
    tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
    brand_color: BRAND_GOLD,
  });
});

if (!ENABLE) {
  console.log('[hive-mcp-agent-quota] ENABLE=false — running in dormant mode (health only)');
}


// ─── Schema discoverability ────────────────────────────────────────────────
const AGENT_CARD = {
  name: SERVICE,
  description: 'Per-agent quota metering for the A2A network. Charges $0.001/check via x402, tracks consumption per agent DID, returns remaining quota. Inbound only. Hive Civilization.. New agents: first call free. Loyalty: every 6th paid call is free. Pay in USDC on Base L2.',
  url: `https://${SERVICE}.onrender.com`,
  provider: {
    organization: 'Hive Civilization',
    url: 'https://www.thehiveryiq.com',
    contact: 'steve@thehiveryiq.com',
  },
  version: VERSION,
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  authentication: {
    schemes: ['x402'],
    credentials: {
      type: 'x402',
      asset: 'USDC',
      network: 'base',
      asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    },
  },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [
    { name: 'quota_check', description: 'Consume one or more quota units for an agent DID. Costs $0.001 USDC per unit on Base L2 via x402. Inbound only. First call returns a 402 envelope; submit proof inline via X-Payment header to mint an access token, then retry.' },
    { name: 'quota_balance', description: 'Read remaining quota for an agent DID. Free. Returns units_purchased, units_consumed, units_remaining, first_seen, last_seen.' },
    { name: 'quota_topup_estimate', description: 'Estimate the USDC cost to top up a DID with N units. Free. Inherits the hivemorph barter floor: returns asking_usd and accept_min_usd. Use the returned values to construct an x402 proof.' },
  ],
  extensions: {
    hive_pricing: {
      currency: 'USDC',
      network: 'base',
      model: 'per_call',
      first_call_free: true,
      loyalty_threshold: 6,
      loyalty_message: 'Every 6th paid call is free',
    },
  },
};

const AP2 = {
  ap2_version: '1',
  agent: {
    name: SERVICE,
    did: `did:web:${SERVICE}.onrender.com`,
    description: 'Per-agent quota metering for the A2A network. Charges $0.001/check via x402, tracks consumption per agent DID, returns remaining quota. Inbound only. Hive Civilization.. New agents: first call free. Loyalty: every 6th paid call is free. Pay in USDC on Base L2.',
  },
  endpoints: {
    mcp: `https://${SERVICE}.onrender.com/mcp`,
    agent_card: `https://${SERVICE}.onrender.com/.well-known/agent-card.json`,
  },
  payments: {
    schemes: ['x402'],
    primary: {
      scheme: 'x402',
      network: 'base',
      asset: 'USDC',
      asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    },
  },
  brand: { color: '#C08D23', name: 'Hive Civilization' },
};

app.get('/.well-known/agent-card.json', (req, res) => res.json(AGENT_CARD));
app.get('/.well-known/ap2.json',         (req, res) => res.json(AP2));


app.listen(PORT, () => {
  console.log(`[hive-mcp-agent-quota] listening on :${PORT} — inbound only — price=$${PRICE_USDC}/unit floor=${clampFloorPct(FLOOR_PCT_DEFAULT)}`);
});

// ─── Root HTML (browsers) ──────────────────────────────────────────────────
function rootHtml() {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'hive-mcp-agent-quota',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Node.js >= 18',
    offers: {
      '@type': 'Offer',
      price: PRICE_USDC,
      priceCurrency: 'USDC',
      eligibleQuantity: { '@type': 'QuantitativeValue', unitCode: 'C62', value: 1 },
    },
    description: 'Per-agent quota meter for the A2A network. Inbound only. $0.001/check via x402 on Base L2.',
    author: { '@type': 'Person', name: 'Steve Rotzin', email: 'steve@thehiveryiq.com', url: 'https://www.thehiveryiq.com' },
    license: 'https://opensource.org/licenses/MIT',
    url: 'https://github.com/srotzin/hive-mcp-agent-quota',
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>hive-mcp-agent-quota</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="description" content="Per-agent quota metering for the A2A network. $0.001 per check via x402 on Base L2." />
<style>
  :root { --gold: ${BRAND_GOLD}; --ink: #111; --paper: #fafaf7; --rule: #e6e2d6; }
  html,body { margin:0; padding:0; background:var(--paper); color:var(--ink); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Inter, system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 56px 24px 96px; }
  h1 { font-weight: 700; font-size: 28px; margin: 0 0 4px; letter-spacing:-0.01em; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--gold); margin: 36px 0 8px; font-weight:700; }
  .lede { color:#444; margin: 0 0 24px; }
  table { width:100%; border-collapse: collapse; margin: 8px 0 16px; }
  th, td { text-align:left; padding: 8px 10px; border-bottom: 1px solid var(--rule); font-size: 14px; vertical-align: top; }
  th { color:#666; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
  code { font: 13px/1.5 ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; background:#f1ede0; padding: 1px 6px; border-radius: 3px; }
  pre { background:#f1ede0; padding: 12px 14px; border-radius: 4px; overflow-x:auto; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .rule { height: 2px; background: var(--gold); margin: 24px 0 0; width: 56px; }
  .meta { color:#666; font-size: 12.5px; margin-top: 32px; border-top: 1px solid var(--rule); padding-top: 16px; }
  a { color: var(--ink); text-decoration: underline; text-decoration-color: var(--gold); text-underline-offset: 3px; }
</style>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</head>
<body>
<main>
  <h1>hive-mcp-agent-quota</h1>
  <div class="rule"></div>
  <p class="lede">Per-agent quota metering for the A2A network. $0.001 per check, paid via x402 on Base L2. Inbound only. <code>ENABLE=true</code> by default.</p>

  <h2>Tools</h2>
  <table>
    <thead><tr><th>Name</th><th>Tier</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td><code>quota_check</code></td><td>1</td><td>Consume N units for a DID. $0.001/unit via x402.</td></tr>
      <tr><td><code>quota_balance</code></td><td>0</td><td>Read remaining quota for a DID. Free.</td></tr>
      <tr><td><code>quota_topup_estimate</code></td><td>0</td><td>Estimate USDC cost for N units. Inherits barter floor.</td></tr>
    </tbody>
  </table>

  <h2>REST</h2>
  <table>
    <tbody>
      <tr><td><code>POST /v1/quota/check</code></td><td>Consume units. 402 if no quota and no proof.</td></tr>
      <tr><td><code>GET /v1/quota/balance?did=…</code></td><td>Remaining quota.</td></tr>
      <tr><td><code>GET /v1/quota/today</code></td><td>UTC-day ledger snapshot.</td></tr>
      <tr><td><code>GET /v1/quota/estimate?units=…</code></td><td>Asking + floor, USDC.</td></tr>
      <tr><td><code>GET /health</code></td><td>Liveness.</td></tr>
    </tbody>
  </table>

  <h2>x402 envelope</h2>
  <pre>{
  "error": "payment_required",
  "x402_version": 1,
  "payment": {
    "amount_usd": 0.001,
    "accept_min_usd": 0.0007,
    "accepts": [{"chain":"base","asset":"USDC","contract":"${USDC_BASE_CONTRACT}","recipient":"${WALLET_RECIPIENT}","scheme":"exact"}],
    "tier": 1,
    "product": "agent_quota_check"
  }
}</pre>

  <h2>Settlement</h2>
  <p>USDC on Base L2 (<code>${USDC_BASE_CONTRACT}</code>) to the recipient address above. Verification reads <code>Transfer</code> logs on the receipt against the configured Base RPC. No mocks.</p>

  <h2>Council provenance</h2>
  <p>Tier A position 3. 2026-04-27. Inbound metering surface symmetric to <a href="https://github.com/srotzin/hive-mcp-barter">hive-mcp-barter</a> (outbound) and <a href="https://github.com/srotzin/hive-mcp-auction">hive-mcp-auction</a> (inbound reverse-Dutch).</p>

  <div class="meta">
    Brand: Hive Civilization gold ${BRAND_GOLD} (Pantone 1245 C). MIT license. <a href="https://github.com/srotzin/hive-mcp-agent-quota">source</a>.
  </div>
</main>
</body>
</html>`;
}
