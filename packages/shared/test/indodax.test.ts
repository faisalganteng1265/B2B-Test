import { describe, expect, it } from 'vitest';
import { indodaxClientId, indodaxSign } from '../src/clients/indodax';

describe('indodax signing', () => {
  it('matches the official docs example (GET /api/v2/myTrades)', () => {
    // INDODAX-TradeAPI-2-Private.md, "SIGNED Endpoint Examples"
    const secret = 'f60617a68fcce028f0a90bc9eb765d17379eb548cc935c01a7ee3186eecf870e9b68f27a31bcfe8d';
    const qs = 'symbol=btcidr&limit=100&timestamp=1578304294000&recvWindow=5000';
    expect(indodaxSign(secret, qs)).toBe('58b503019a8f2754af7097b4d981913a8dca9e5cb2b408061cbd48736a940558');
  });
  it('derives deterministic, ≤36-char alphanumeric client ids', () => {
    const wf = '84532:0x83901ec6d51d7189a0f1ced1269b5419321cacff796c164f01b6a5f823b9ab1c:0';
    const a = indodaxClientId(wf, 'sell');
    expect(a).toBe(indodaxClientId(wf, 'sell'));
    expect(a).not.toBe(indodaxClientId(wf, 'sweep'));
    expect(a).toMatch(/^[a-z0-9]{1,36}$/);
  });
});
