import { randomUUID } from 'node:crypto';
import * as clients from '@restatedev/restate-sdk-clients';
import { eq, isNull, and } from 'drizzle-orm';
import { payouts, webhookEvents, type Db } from '@mopay/db';
import { bifastCallbackSchema, verifyHmacHex, type Logger } from '@mopay/shared';
import type { PayoutSignal } from './offramp';

export interface CallbackDeps {
  db: Db;
  webhookSecret: string;
  resolveAwakeable: (id: string, payload: PayoutSignal) => Promise<void>;
  log: Logger;
}

export type CallbackOutcome =
  | { http: 200; body: { ok: true; duplicate?: boolean } }
  | { http: 400 | 401 | 404 | 503; body: { error: { code: string; message: string } } };

export function restateAwakeableResolver(ingressUrl: string) {
  const ingress = clients.connect({ url: ingressUrl });
  return (id: string, payload: PayoutSignal) => ingress.resolveAwakeable(id, payload);
}

/**
 * BI-FAST callback → workflow. Order of operations:
 *  1. verify HMAC on the RAW body (invalid → 401, recorded, no state change)
 *  2. dedup on transferId+status via webhook_events.external_id UNIQUE
 *  3. look up the payout by idempotency key (stored BEFORE the transfer was sent)
 *  4. resolve the workflow's awakeable through the Restate ingress
 *  5. mark processed. Any failure before 5 → non-2xx, so BI-FAST redelivers.
 */
export async function handleBifastCallback(
  deps: CallbackDeps,
  rawBody: string,
  signature: string | undefined,
): Promise<CallbackOutcome> {
  const { db, log } = deps;
  const valid = verifyHmacHex(deps.webhookSecret, rawBody, signature);
  let parsedJson: unknown = null;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    /* recorded below */
  }
  if (!valid) {
    await db
      .insert(webhookEvents)
      .values({
        source: 'bifast',
        externalId: `invalid:${randomUUID()}`,
        payload: { raw: rawBody.slice(0, 2000) },
        signatureValid: false,
      })
      .catch(() => {});
    log.warn({ source: 'bifast' }, 'webhook rejected: invalid signature');
    return {
      http: 401,
      body: { error: { code: 'INVALID_SIGNATURE', message: 'signature verification failed' } },
    };
  }
  const parsed = bifastCallbackSchema.safeParse(parsedJson);
  if (!parsed.success)
    return { http: 400, body: { error: { code: 'VALIDATION', message: parsed.error.message } } };
  const cb = parsed.data;
  const externalId = `${cb.transferId}:${cb.status}`;

  await db
    .insert(webhookEvents)
    .values({ source: 'bifast', externalId, payload: cb, signatureValid: true })
    .onConflictDoNothing();
  const ev = await db.query.webhookEvents.findFirst({ where: eq(webhookEvents.externalId, externalId) });
  if (ev?.processedAt) {
    log.info({ transferId: cb.transferId }, 'duplicate webhook ignored');
    return { http: 200, body: { ok: true, duplicate: true } };
  }

  const p = await db.query.payouts.findFirst({ where: eq(payouts.idempotencyKey, cb.idempotencyKey) });
  if (!p) return { http: 404, body: { error: { code: 'UNKNOWN_PAYOUT', message: cb.idempotencyKey } } };
  const correlationId = p.depositId;
  if (p.bifastRef && p.bifastRef !== cb.transferId) {
    log.error(
      { correlationId, transferId: cb.transferId, expected: p.bifastRef },
      'webhook transferId mismatch',
    );
    return {
      http: 400,
      body: { error: { code: 'TRANSFER_MISMATCH', message: 'transferId does not match payout' } },
    };
  }
  if (!p.awakeableId)
    return { http: 503, body: { error: { code: 'NOT_READY', message: 'workflow not waiting yet' } } };

  await deps.resolveAwakeable(p.awakeableId, {
    transferId: cb.transferId,
    status: cb.status,
    reason: cb.reason,
  });
  await db
    .update(webhookEvents)
    .set({ processedAt: new Date() })
    .where(and(eq(webhookEvents.externalId, externalId), isNull(webhookEvents.processedAt)));
  log.info(
    { correlationId, transferId: cb.transferId, status: cb.status },
    'payout callback forwarded to workflow',
  );
  return { http: 200, body: { ok: true } };
}
