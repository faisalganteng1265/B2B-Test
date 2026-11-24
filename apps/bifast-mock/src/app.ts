import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { BANK_DIRECTORY, Chaos, hmacHex, type Logger } from '@mopay/shared';

export interface BifastDeps {
  dbPath: string;
  chaos: Chaos;
  apiKey: string;
  adminToken: string;
  webhookSecret: string;
  callbackUrl: string;
  /** settlement delay range for a transfer */
  settleMs: [number, number];
  log: Logger;
  now?: () => number;
  rand?: () => number;
  fetchImpl?: typeof fetch;
}

const MAX_CALLBACK_ATTEMPTS = 8;
const FAILURE_REASONS = ['ACCOUNT_CLOSED', 'BANK_UNAVAILABLE'] as const;

const fail = (c: Context, status: number, code: string, message: string) =>
  c.json({ error: { code, message } }, status as 400);

const inquiryBody = z.object({
  bankCode: z.string().regex(/^\d{3}$/),
  accountNumber: z.string().regex(/^\d{6,20}$/),
});
const transferBody = inquiryBody.extend({
  accountName: z.string().min(1),
  amount: z.string().regex(/^[1-9]\d*$/),
  remark: z.string().max(140).optional(),
});

interface TransferRow {
  id: string;
  idempotency_key: string;
  request_hash: string;
  bank_code: string;
  account_number: string;
  account_name: string;
  amount: string;
  status: 'pending' | 'success' | 'failed';
  reason: string | null;
  outcome: 'success' | 'failed';
  outcome_reason: string | null;
  complete_at_ms: number;
  callback_state: 'pending' | 'sent' | 'dropped' | 'failed';
  callback_attempts: number;
  next_callback_ms: number;
  duplicate: number;
  created_at: string;
  completed_at: string | null;
}

export function createBifast(d: BifastDeps) {
  const now = d.now ?? Date.now;
  const rand = d.rand ?? Math.random;
  const fetchImpl = d.fetchImpl ?? fetch;
  if (d.dbPath !== ':memory:') mkdirSync(dirname(d.dbPath), { recursive: true });
  const db = new DatabaseSync(d.dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
      bank_code TEXT NOT NULL, account_number TEXT NOT NULL, account_name TEXT NOT NULL, amount TEXT NOT NULL,
      status TEXT NOT NULL, reason TEXT, outcome TEXT NOT NULL, outcome_reason TEXT,
      complete_at_ms INTEGER NOT NULL, callback_state TEXT NOT NULL, callback_attempts INTEGER NOT NULL DEFAULT 0,
      next_callback_ms INTEGER NOT NULL, duplicate INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, completed_at TEXT);
    CREATE INDEX IF NOT EXISTS transfers_cb_idx ON transfers (callback_state, next_callback_ms);
  `);

  const get = (id: string) =>
    db.prepare('SELECT * FROM transfers WHERE id = ?').get(id) as TransferRow | undefined;
  const toJson = (t: TransferRow) => ({
    transferId: t.id,
    idempotencyKey: t.idempotency_key,
    bankCode: t.bank_code,
    accountNumber: t.account_number,
    amount: t.amount,
    status: t.status,
    reason: t.reason,
    createdAt: t.created_at,
    completedAt: t.completed_at,
  });

  /** Settle transfers whose time has come (idempotent). */
  function settleDue() {
    db.prepare(
      `UPDATE transfers SET status = outcome, reason = outcome_reason, completed_at = ?
       WHERE status = 'pending' AND complete_at_ms <= ?`,
    ).run(new Date(now()).toISOString(), now());
  }

  async function sendCallback(t: TransferRow): Promise<boolean> {
    const body = JSON.stringify({
      transferId: t.id,
      idempotencyKey: t.idempotency_key,
      status: t.status,
      ...(t.reason ? { reason: t.reason } : {}),
    });
    try {
      const res = await fetchImpl(d.callbackUrl, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', 'x-signature': hmacHex(d.webhookSecret, body) },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  let ticking = false;
  /** One scheduler pass: settle due transfers and deliver due callbacks. Safe to call repeatedly. */
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      settleDue();
      const due = db
        .prepare(
          `SELECT * FROM transfers WHERE status != 'pending' AND callback_state = 'pending' AND next_callback_ms <= ? LIMIT 50`,
        )
        .all(now()) as unknown as TransferRow[];
      await Promise.all(
        due.map(async (t) => {
          const ok = await sendCallback(t);
          if (ok) {
            db.prepare(
              `UPDATE transfers SET callback_state = 'sent', callback_attempts = callback_attempts + 1 WHERE id = ?`,
            ).run(t.id);
            if (t.duplicate) {
              d.log.info({ transferId: t.id }, 'chaos: sending duplicate callback');
              await sendCallback(t);
            }
          } else {
            const attempts = t.callback_attempts + 1;
            const state = attempts >= MAX_CALLBACK_ATTEMPTS ? 'failed' : 'pending';
            const backoff = Math.min(60_000, 500 * 2 ** attempts);
            db.prepare(
              'UPDATE transfers SET callback_attempts = ?, callback_state = ?, next_callback_ms = ? WHERE id = ?',
            ).run(attempts, state, now() + backoff, t.id);
            d.log.warn({ transferId: t.id, attempts, state }, 'callback delivery failed');
          }
        }),
      );
    } finally {
      ticking = false;
    }
  }

  const app = new Hono();
  app.onError((err, c) => {
    d.log.error({ err }, 'unhandled');
    return fail(c, 500, 'INTERNAL', err.message);
  });
  app.get('/healthz', (c) => c.json({ ok: true }));
  d.chaos.mount(app, d.adminToken);

  const v1 = new Hono();
  v1.use('*', d.chaos.middleware());
  v1.use('*', async (c, next) => {
    if (c.req.header('x-api-key') !== d.apiKey) return fail(c, 401, 'UNAUTHORIZED', 'invalid api key');
    await next();
  });

  v1.post('/account-inquiry', async (c) => {
    const b = inquiryBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return fail(c, 400, 'VALIDATION', b.error.message);
    const acct = BANK_DIRECTORY.find(
      (a) => a.bankCode === b.data.bankCode && a.accountNumber === b.data.accountNumber,
    );
    if (!acct) return fail(c, 404, 'ACCOUNT_NOT_FOUND', 'account not found');
    // Inquiry succeeds for closed accounts too (realistic: the failure surfaces at credit time).
    return c.json({
      bankCode: acct.bankCode,
      accountNumber: acct.accountNumber,
      accountName: acct.accountName,
      status: 'active',
    });
  });

  v1.post('/transfers', async (c) => {
    const key = c.req.header('idempotency-key');
    if (!key) return fail(c, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header required');
    const raw = await c.req.text();
    const b = transferBody.safeParse(JSON.parse(raw || '{}'));
    if (!b.success) return fail(c, 400, 'VALIDATION', b.error.message);
    const reqHash = createHash('sha256').update(raw).digest('hex');

    db.exec('BEGIN IMMEDIATE');
    let row: TransferRow;
    try {
      const prev = db.prepare('SELECT * FROM transfers WHERE idempotency_key = ?').get(key) as
        TransferRow | undefined;
      if (prev) {
        db.exec('COMMIT');
        if (prev.request_hash !== reqHash)
          return fail(c, 422, 'IDEMPOTENCY_KEY_REUSED', 'key used with a different request');
        c.header('idempotent-replay', 'true');
        return c.json(toJson(prev), 202);
      }
      const acct = BANK_DIRECTORY.find(
        (a) => a.bankCode === b.data.bankCode && a.accountNumber === b.data.accountNumber,
      );
      let outcome: 'success' | 'failed' = 'success';
      let reason: string | null = null;
      if (!acct || acct.status === 'closed') {
        outcome = 'failed';
        reason = 'ACCOUNT_CLOSED';
      } else if (d.chaos.roll(d.chaos.config.FINAL_FAILURE_RATE)) {
        outcome = 'failed';
        reason = FAILURE_REASONS[Math.floor(rand() * FAILURE_REASONS.length)]!;
      }
      const [lo, hi] = d.settleMs;
      const completeAt = now() + lo + Math.floor(rand() * Math.max(0, hi - lo));
      const dropped = d.chaos.roll(d.chaos.config.DROP_CALLBACK_RATE);
      const id = `bf_${randomUUID()}`;
      db.prepare(
        `INSERT INTO transfers (id, idempotency_key, request_hash, bank_code, account_number, account_name, amount, status,
           outcome, outcome_reason, complete_at_ms, callback_state, next_callback_ms, duplicate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        key,
        reqHash,
        b.data.bankCode,
        b.data.accountNumber,
        b.data.accountName,
        b.data.amount,
        outcome,
        reason,
        completeAt,
        dropped ? 'dropped' : 'pending',
        completeAt + d.chaos.config.LATE_CALLBACK_MS,
        d.chaos.roll(d.chaos.config.DUPLICATE_CALLBACK_RATE) ? 1 : 0,
        new Date(now()).toISOString(),
      );
      row = get(id)!;
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    d.log.info({ transferId: row.id, idempotencyKey: key, amount: row.amount }, 'transfer accepted');
    return c.json(toJson(row), 202);
  });

  v1.get('/transfers/:id', (c) => {
    settleDue();
    const t = get(c.req.param('id'));
    if (!t) return fail(c, 404, 'NOT_FOUND', 'transfer not found');
    return c.json(toJson(t));
  });

  app.route('/v1', v1);

  app.get('/__state', (c) => {
    if (c.req.header('x-admin-token') !== d.adminToken) return fail(c, 401, 'UNAUTHORIZED', 'admin only');
    const r = db
      .prepare(
        `SELECT count(*) AS transfers, count(DISTINCT idempotency_key) AS keys, sum(status = 'success') AS success FROM transfers`,
      )
      .get();
    return c.json(r);
  });

  return { app, tick, db };
}
