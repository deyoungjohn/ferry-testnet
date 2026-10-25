import { describe, it, expect } from 'vitest';
import { transition } from '../src/state-machine/transitions.js';
import type {
  ForwardOrderStatus,
  SolverEvent,
  SolverOrderRecord,
} from '../src/state-machine/types.js';
import { parseOrderTerms } from '@ferry/core';

describe('Solver pure state machine transitions', () => {
  const dummyTerms = parseOrderTerms({
    version: 1,
    direction: 'COUNTER_TO_BCH',
    bchToken: 'PUSD',
    bchTokenCategory: `0x${'aa'.repeat(32)}`,
    bchTokenAmount: 2485n,
    counterAmount: 25000000n,
    counterChain: 'base',
    counterNetworkId: 31337,
    counterAsset: {
      symbol: 'USDC',
      decimals: 6,
      address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    },
    counterHtlc: '0x5A0C062f4B7b8fF2263530e12bc15De9C836a641',
    userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
    userBchLockingBytecode:
      '0x76a914000000000000000000000000000000000000000088ac',
    solverCounterAddress: '0xC9ec91859Bdb598dC2eeE715934D8231478f7A70',
    solverBchLockingBytecode:
      '0x76a914111111111111111111111111111111111111111188ac',
    hashLock: `0x${'bb'.repeat(32)}`,
    counterDeadline: 1700086400,
    bchRefundHeight: 330000,
    bchCarrySats: 3000n,
    bchMaxFee: 1500n,
    quoteId: 'test-quote-1',
    quoteExpiry: 1700000120,
  });

  function makeOrder(
    status: ForwardOrderStatus,
    secret?: `0x${string}` | undefined,
    secretSource?: 'cooperative' | 'on_chain_claim' | undefined,
  ): SolverOrderRecord {
    return {
      id: '0x1234',
      direction: 'COUNTER_TO_BCH',
      status,
      terms: dummyTerms,
      hashLock: dummyTerms.hashLock,
      secret,
      secretSource,
      createdAt: 1000,
      updatedAt: 1000,
    };
  }

  // Table of all valid forward edges
  const forwardEdges: Array<{
    from: ForwardOrderStatus;
    event: SolverEvent;
    expectedNext: ForwardOrderStatus;
  }> = [
    {
      from: 'QUOTED',
      event: { type: 'USER_LOCK_SEEN', txId: '0xevm1' },
      expectedNext: 'USER_LOCK_SEEN',
    },
    {
      from: 'USER_LOCK_SEEN',
      event: { type: 'USER_LOCK_FINAL', txId: '0xevm1' },
      expectedNext: 'USER_LOCK_FINAL',
    },
    {
      from: 'USER_LOCK_FINAL',
      event: { type: 'SOLVER_LOCK_BROADCAST', txId: '0xbch1' },
      expectedNext: 'SOLVER_LOCK_BROADCAST',
    },
    {
      from: 'SOLVER_LOCK_BROADCAST',
      event: { type: 'SOLVER_LOCK_SEEN', txId: '0xbch1' },
      expectedNext: 'SOLVER_LOCK_SEEN',
    },
    {
      from: 'SOLVER_LOCK_SEEN',
      event: {
        type: 'SECRET_REVEALED_COOPERATIVE',
        secret: `0x${'cc'.repeat(32)}`,
      },
      expectedNext: 'SECRET_KNOWN',
    },
    {
      from: 'SECRET_KNOWN',
      event: {
        type: 'USER_CLAIM_SEEN',
        txId: '0xbchclaim',
        secret: `0x${'cc'.repeat(32)}`,
      },
      expectedNext: 'USER_CLAIM_SEEN',
    },
    {
      from: 'USER_CLAIM_SEEN',
      event: { type: 'SOLVER_CLAIM_BROADCAST', txId: '0xevmclaim' },
      expectedNext: 'SOLVER_CLAIM_BROADCAST',
    },
    {
      from: 'SOLVER_CLAIM_BROADCAST',
      event: { type: 'SOLVER_CLAIM_FINAL', txId: '0xevmclaim' },
      expectedNext: 'SOLVER_CLAIM_FINAL',
    },
    {
      from: 'SOLVER_CLAIM_FINAL',
      event: { type: 'SWAP_COMPLETE' },
      expectedNext: 'DONE',
    },
  ];

  for (const edge of forwardEdges) {
    it(`transitions from ${edge.from} -> ${edge.expectedNext} on event ${edge.event.type}`, () => {
      const order = makeOrder(edge.from);
      const res = transition(order, edge.event);
      expect(res.nextStatus).toBe(edge.expectedNext);
    });
  }

  // Direct on-chain claim without prior cooperative reveal
  it('transitions from SOLVER_LOCK_SEEN directly to USER_CLAIM_SEEN if user claims on chain', () => {
    const order = makeOrder('SOLVER_LOCK_SEEN');
    const secret = `0x${'dd'.repeat(32)}` as const;
    const res = transition(order, {
      type: 'USER_CLAIM_SEEN',
      txId: '0xbchclaim2',
      secret,
    });
    expect(res.nextStatus).toBe('USER_CLAIM_SEEN');
    expect(res.mutations?.secret).toBe(secret);
    expect(res.mutations?.secretSource).toBe('on_chain_claim');
  });

  // Cooperative reveal marks secretSource as cooperative
  it('marks secretSource as cooperative on SECRET_REVEALED_COOPERATIVE', () => {
    const order = makeOrder('SOLVER_LOCK_SEEN');
    const secret = `0x${'ee'.repeat(32)}` as const;
    const res = transition(order, {
      type: 'SECRET_REVEALED_COOPERATIVE',
      secret,
    });
    expect(res.nextStatus).toBe('SECRET_KNOWN');
    expect(res.mutations?.secret).toBe(secret);
    expect(res.mutations?.secretSource).toBe('cooperative');
  });

  // Subsequent on-chain claim updates secretSource to on_chain_claim
  it('updates secretSource from cooperative to on_chain_claim when user claims on chain', () => {
    const order = makeOrder(
      'SECRET_KNOWN',
      `0x${'ee'.repeat(32)}`,
      'cooperative',
    );
    const res = transition(order, {
      type: 'USER_CLAIM_SEEN',
      txId: '0xbchclaim3',
      secret: `0x${'ee'.repeat(32)}`,
    });
    expect(res.nextStatus).toBe('USER_CLAIM_SEEN');
    expect(res.mutations?.secretSource).toBe('on_chain_claim');
  });

  // Abort edges
  it('aborts from QUOTED on QUOTE_EXPIRED', () => {
    const order = makeOrder('QUOTED');
    const res = transition(order, { type: 'QUOTE_EXPIRED' });
    expect(res.nextStatus).toBe('EXPIRED');
  });

  it('aborts from QUOTED or USER_LOCK_SEEN on INVALID_TERMS', () => {
    const order1 = makeOrder('QUOTED');
    expect(
      transition(order1, { type: 'INVALID_TERMS', reason: 'bad terms' })
        .nextStatus,
    ).toBe('REJECTED');

    const order2 = makeOrder('USER_LOCK_SEEN');
    expect(
      transition(order2, { type: 'INVALID_TERMS', reason: 'bad terms' })
        .nextStatus,
    ).toBe('REJECTED');
  });

  it('aborts to SOLVER_REFUNDED on BCH_DEADLINE_PASSED', () => {
    const order = makeOrder('SOLVER_LOCK_SEEN');
    const res = transition(order, {
      type: 'BCH_DEADLINE_PASSED',
      refundTxId: '0xbchrefund1',
    });
    expect(res.nextStatus).toBe('SOLVER_REFUNDED');
    expect(res.mutations?.solverRefundTxId).toBe('0xbchrefund1');
  });

  // Terminal state idempotency
  it('ignores events once in terminal states', () => {
    const terminalStates: ForwardOrderStatus[] = [
      'DONE',
      'EXPIRED',
      'REJECTED',
      'SOLVER_REFUNDED',
    ];
    for (const term of terminalStates) {
      const order = makeOrder(term);
      const res = transition(order, { type: 'USER_LOCK_SEEN', txId: '0xlate' });
      expect(res.nextStatus).toBe(term);
    }
  });

  // Note for reverse direction:
  // TODO: Add reverse flow table tests in L5 when ReverseOrderStatus and reverse edges are integrated.
});
