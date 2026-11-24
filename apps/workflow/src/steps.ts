import * as restate from '@restatedev/restate-sdk';
import { and, eq, sql } from 'drizzle-orm';
import { auditLog, offrampRuns, offrampStepEvents, type Db } from '@mopay/db';
import { classifyError, errMsg, UpstreamError, type Logger } from '@mopay/shared';

export type StepName = (typeof offrampRuns.$inferSelect)['step'];

export interface StepConfig {
  initialRetryIntervalMs: number;
  maxRetryIntervalMs: number;
  /** log an ALERT (and audit) when a single step has failed this many times */
  alertAfterAttempts: number;
}

/** Terminal error carrying a machine-readable code in the message: "[CODE] message". */
export function terminal(code: string, message: string): restate.TerminalError {
  return new restate.TerminalError(`[${code}] ${message}`);
}

export function terminalCode(e: unknown): string | null {
  if (!(e instanceof restate.TerminalError)) return null;
  const m = /^\[([A-Z_]+)\]/.exec(e.message);
  return m ? m[1]! : 'TERMINAL';
}

export interface StepCtx {
  ctx: restate.WorkflowContext;
  db: Db;
  depositId: string;
  log: Logger;
  cfg: StepConfig;
}

/**
 * A durable, auto-retried workflow step.
 * - The action runs inside `ctx.run`: its result is journaled by Restate and never re-executed
 *   after a crash/replay.
 * - Retryable errors (5xx, timeout, network, PRICE_UNAVAILABLE…) are rethrown, so Restate retries
 *   with exponential backoff and NO attempt limit (requirement: "retry until success").
 * - Terminal errors become `TerminalError` (not retried) and are handled by the workflow.
 * - Every attempt is written to `offramp_step_events` + `offramp_runs` (dashboard timeline).
 * The action itself MUST be idempotent (external calls use deterministic idempotency keys).
 */
export function step<T>(
  s: StepCtx,
  name: StepName,
  action: () => Promise<T>,
  label: string = name,
): Promise<T> {
  const { ctx, db, depositId, log, cfg } = s;
  return ctx.run(
    label,
    async () => {
      const attempt = await recordStart(db, depositId, name);
      try {
        const out = await action();
        await db
          .insert(offrampStepEvents)
          .values({ depositId, step: name, kind: 'succeeded', attempt })
          .catch(() => {});
        log.info({ correlationId: depositId, step: name, label, attempt }, 'step succeeded');
        return out;
      } catch (e) {
        const msg = errMsg(e);
        const isTerminal = e instanceof restate.TerminalError || classifyError(e) === 'terminal';
        await db
          .insert(offrampStepEvents)
          .values({
            depositId,
            step: name,
            kind: isTerminal ? 'failed' : 'retrying',
            attempt,
            error: msg.slice(0, 500),
          })
          .catch(() => {});
        await db
          .update(offrampRuns)
          .set({ lastError: msg.slice(0, 500), updatedAt: new Date() })
          .where(eq(offrampRuns.depositId, depositId))
          .catch(() => {});
        if (isTerminal) {
          log.warn({ correlationId: depositId, step: name, err: msg }, 'step failed terminally');
          if (e instanceof restate.TerminalError) throw e;
          throw terminal(e instanceof UpstreamError ? e.code : 'TERMINAL', msg);
        }
        if (attempt >= cfg.alertAfterAttempts) {
          log.error(
            { correlationId: depositId, step: name, attempt, err: msg },
            'ALERT: step keeps failing (still retrying)',
          );
          if (attempt === cfg.alertAfterAttempts) {
            await db
              .insert(auditLog)
              .values({
                actor: 'workflow',
                action: 'step_retry_alert',
                entity: 'deposit',
                entityId: depositId,
                data: { step: name, attempt, error: msg },
              })
              .catch(() => {});
          }
        } else {
          log.warn(
            { correlationId: depositId, step: name, attempt, err: msg },
            'step failed; restate will retry',
          );
        }
        throw e;
      }
    },
    {
      initialRetryInterval: cfg.initialRetryIntervalMs,
      maxRetryInterval: cfg.maxRetryIntervalMs,
      retryIntervalFactor: 2,
      // maxRetryAttempts intentionally omitted: retryable errors retry forever.
    },
  );
}

/** Best-effort timeline bookkeeping: it must never block or fail the step itself. */
async function recordStart(db: Db, depositId: string, name: StepName): Promise<number> {
  try {
    return await recordStartUnsafe(db, depositId, name);
  } catch {
    return 1;
  }
}

async function recordStartUnsafe(db: Db, depositId: string, name: StepName): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(offrampStepEvents)
    .where(
      and(
        eq(offrampStepEvents.depositId, depositId),
        eq(offrampStepEvents.step, name),
        eq(offrampStepEvents.kind, 'started'),
      ),
    );
  const attempt = Number(r?.n ?? 0) + 1;
  await db.insert(offrampStepEvents).values({ depositId, step: name, kind: 'started', attempt });
  await db
    .update(offrampRuns)
    .set({ step: name, attempts: sql`${offrampRuns.attempts} + 1`, updatedAt: new Date() })
    .where(eq(offrampRuns.depositId, depositId));
  return attempt;
}
