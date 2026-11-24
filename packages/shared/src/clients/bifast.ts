import { z } from 'zod';
import { httpJson, type HttpOptions } from './http';

export interface BifastInquiry {
  bankCode: string;
  accountNumber: string;
  accountName: string;
  status: 'active';
}
export interface BifastTransfer {
  transferId: string;
  idempotencyKey: string;
  bankCode: string;
  accountNumber: string;
  amount: string;
  status: 'pending' | 'success' | 'failed';
  reason: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Callback body sent by BI-FAST (via PJP) to Mopay. Signed with X-Signature = hex HMAC-SHA256(body). */
export const bifastCallbackSchema = z.object({
  transferId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  status: z.enum(['success', 'failed']),
  reason: z.string().optional(),
});
export type BifastCallback = z.infer<typeof bifastCallbackSchema>;

export interface BifastClientOptions extends HttpOptions {
  apiKey: string;
}

export class BifastClient {
  constructor(private readonly o: BifastClientOptions) {}
  private req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return httpJson<T>(this.o, method, path, body === undefined ? undefined : JSON.stringify(body), {
      'x-api-key': this.o.apiKey,
      ...headers,
    });
  }
  accountInquiry(bankCode: string, accountNumber: string) {
    return this.req<BifastInquiry>('POST', '/v1/account-inquiry', { bankCode, accountNumber });
  }
  createTransfer(
    idempotencyKey: string,
    t: { bankCode: string; accountNumber: string; accountName: string; amount: bigint; remark?: string },
  ) {
    return this.req<BifastTransfer>(
      'POST',
      '/v1/transfers',
      { ...t, amount: t.amount.toString() },
      { 'idempotency-key': idempotencyKey },
    );
  }
  getTransfer(transferId: string) {
    return this.req<BifastTransfer>('GET', `/v1/transfers/${encodeURIComponent(transferId)}`);
  }
}
