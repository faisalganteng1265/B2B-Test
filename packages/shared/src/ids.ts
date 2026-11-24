/** Deterministic workflow id for a deposit log: "{chainId}:{txHash}:{logIndex}". */
export function depositWorkflowId(chainId: number, txHash: string, logIndex: number): string {
  return `${chainId}:${txHash.toLowerCase()}:${logIndex}`;
}

export const swapIdempotencyKey = (workflowId: string) => `${workflowId}:swap`;
export const payoutIdempotencyKey = (workflowId: string) => `${workflowId}:payout`;
