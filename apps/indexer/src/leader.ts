import type postgres from 'postgres';
import type { Logger } from '@mopay/shared';

/**
 * Leader election with a Postgres session advisory lock on a dedicated connection. Only the leader
 * runs the live worker / promoter / dispatcher; any replica may run backfill workers. If the
 * leader dies its session ends, the lock is released, and a standby takes over within `pollMs`.
 */
export class LeaderLock {
  private conn: postgres.ReservedSql | null = null;
  private leader = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sql: postgres.Sql,
    private readonly key: string,
    private readonly log: Logger,
    private readonly pollMs = 3000,
  ) {}

  isLeader = () => this.leader;

  async start() {
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  private async tick() {
    try {
      this.conn ??= await this.sql.reserve();
      if (this.leader) {
        await this.conn`SELECT 1`; // connection health = leadership health
        return;
      }
      const [r] = await this.conn`SELECT pg_try_advisory_lock(hashtext(${this.key})) AS ok`;
      if (r?.ok) {
        this.leader = true;
        this.log.info({ key: this.key }, 'acquired leadership');
      }
    } catch (e) {
      if (this.leader) this.log.error({ err: e }, 'lost leadership (connection error)');
      this.leader = false;
      this.conn?.release();
      this.conn = null;
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.conn) {
      if (this.leader) await this.conn`SELECT pg_advisory_unlock(hashtext(${this.key}))`.catch(() => {});
      this.conn.release();
    }
    this.leader = false;
  }
}
