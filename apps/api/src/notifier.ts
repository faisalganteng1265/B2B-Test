import type postgres from 'postgres';
import type { Logger } from '@mopay/shared';

export type Listener = (payload: string) => void;

/** One LISTEN connection per API process, fanned out to all SSE subscribers. */
export class Notifier {
  private listeners = new Set<Listener>();
  private started = false;
  constructor(
    private readonly sql: postgres.Sql,
    private readonly log: Logger,
  ) {}

  async start() {
    if (this.started) return;
    this.started = true;
    // postgres.js re-establishes LISTEN automatically after a reconnect.
    await this.sql.listen('mopay_events', (payload) => {
      for (const l of this.listeners) l(payload);
    });
    this.log.info('listening on mopay_events');
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get subscribers() {
    return this.listeners.size;
  }
}
