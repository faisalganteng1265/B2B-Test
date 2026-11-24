import * as clients from '@restatedev/restate-sdk-clients';

export interface Dispatcher {
  /** Start the offramp workflow for a deposit. Must be idempotent per workflowId. */
  dispatch(workflowId: string, depositId: string): Promise<'accepted' | 'duplicate'>;
}

type OfframpDef = { run: (ctx: unknown, input: { depositId: string }) => Promise<unknown> };

/**
 * Dispatch through the Restate ingress. The workflow key IS the deterministic workflow id
 * ("{chainId}:{txHash}:{logIndex}"), and Restate runs `run` at most once per key, so a duplicate
 * dispatch (crash between submit and DB update, or two dispatchers) is harmless.
 */
export class RestateDispatcher implements Dispatcher {
  private readonly ingress: clients.Ingress;
  constructor(url: string) {
    this.ingress = clients.connect({ url });
  }
  async dispatch(workflowId: string, depositId: string) {
    const res = await this.ingress
      .workflowClient<OfframpDef>(
        { name: 'offramp' } as clients.WorkflowDefinitionFrom<OfframpDef>,
        workflowId,
      )
      .workflowSubmit({ depositId });
    return res.status === 'Accepted' ? 'accepted' : 'duplicate';
  }
}
