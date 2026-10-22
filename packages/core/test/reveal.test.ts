import { describe, expect, it } from 'vitest';
import { revealPolicy, DEFAULT_REVEAL_CONFIG } from '../src/reveal.js';
import type { RevealInput, LockEvidence } from '../src/reveal.js';
const locked: LockEvidence = { exists: true, confirmations: 0 };
function input(
  chain: RevealInput['chain'],
  lane: RevealInput['lane'],
  evidence: Partial<LockEvidence>,
): RevealInput {
  return {
    chain,
    lane,
    fastOptIn: true,
    amountUsdMicros: 25000000n,
    evidence: { ...locked, ...evidence },
  };
}
const rows: Array<[string, RevealInput, boolean]> = [
  [
    'BCH fast pending',
    input('bch', 'fast', { dsproof: 'clear', dsproofElapsedMs: 4999 }),
    false,
  ],
  [
    'BCH fast clear at boundary',
    input('bch', 'fast', { dsproof: 'clear', dsproofElapsedMs: 5000 }),
    true,
  ],
  [
    'BCH fast missing proof service',
    input('bch', 'fast', { dsproof: 'unavailable', dsproofElapsedMs: 5000 }),
    false,
  ],
  ['BCH fast missing evidence', input('bch', 'fast', {}), false],
  ['BCH fast confirmed', input('bch', 'fast', { confirmations: 1 }), true],
  [
    'BCH safe unconfirmed',
    input('bch', 'safe', { dsproof: 'clear', dsproofElapsedMs: 6000 }),
    false,
  ],
  ['BCH safe confirmed', input('bch', 'safe', { confirmations: 1 }), true],
  [
    'BCH detected proof',
    input('bch', 'safe', { confirmations: 1, dsproof: 'detected' }),
    false,
  ],
  ['Base fast shallow', input('base', 'fast', { confirmations: 9 }), false],
  ['Base fast threshold', input('base', 'fast', { confirmations: 10 }), true],
  [
    'Base safe lacks safe tag',
    input('base', 'safe', { confirmations: 10 }),
    false,
  ],
  [
    'Base safe threshold',
    input('base', 'safe', { confirmations: 10, safe: true }),
    true,
  ],
  [
    'Ethereum fast shallow',
    input('ethereum', 'fast', { confirmations: 2 }),
    false,
  ],
  [
    'Ethereum fast threshold',
    input('ethereum', 'fast', { confirmations: 3 }),
    true,
  ],
  [
    'Ethereum safe unfinalized',
    input('ethereum', 'safe', { confirmations: 3 }),
    false,
  ],
  [
    'Ethereum safe finalized',
    input('ethereum', 'safe', { confirmations: 3, finalized: true }),
    true,
  ],
  [
    'Arbitrum fast age below',
    input('arbitrum', 'fast', { confirmations: 1, ageSeconds: 9 }),
    false,
  ],
  [
    'Arbitrum fast threshold',
    input('arbitrum', 'fast', { confirmations: 1, ageSeconds: 10 }),
    true,
  ],
  [
    'Arbitrum safe lacks tag',
    input('arbitrum', 'safe', { confirmations: 1, ageSeconds: 10 }),
    false,
  ],
  [
    'Arbitrum safe threshold',
    input('arbitrum', 'safe', { confirmations: 1, ageSeconds: 10, safe: true }),
    true,
  ],
  [
    'Solana processed',
    input('solana', 'fast', { commitment: 'processed' }),
    false,
  ],
  [
    'Solana fast confirmed',
    input('solana', 'fast', { commitment: 'confirmed' }),
    true,
  ],
  [
    'Solana safe confirmed',
    input('solana', 'safe', { commitment: 'confirmed' }),
    false,
  ],
  [
    'Solana safe finalized',
    input('solana', 'safe', { commitment: 'finalized' }),
    true,
  ],
  ...(['arc', 'bsc'] as const).flatMap((chain) =>
    (['fast', 'safe'] as const).flatMap(
      (lane) =>
        [
          [
            `${chain} ${lane} unfinalized`,
            input(chain, lane, { confirmations: 1 }),
            false,
          ],
          [
            `${chain} ${lane} finalized`,
            input(chain, lane, { confirmations: 1, finalized: true }),
            true,
          ],
        ] as Array<[string, RevealInput, boolean]>,
    ),
  ),
  ...(['fast', 'safe'] as const).flatMap(
    (lane) =>
      [
        [
          `Tron ${lane} shallow`,
          input('tron', lane, { confirmations: 18, finalized: true }),
          false,
        ],
        [
          `Tron ${lane} unfinalized`,
          input('tron', lane, { confirmations: 19 }),
          false,
        ],
        [
          `Tron ${lane} solidified`,
          input('tron', lane, { confirmations: 19, finalized: true }),
          true,
        ],
      ] as Array<[string, RevealInput, boolean]>,
  ),
];
describe('reveal decision table', () => {
  it.each(rows)('%s', (_label, value, allowed) =>
    expect(revealPolicy(value).allowed).toBe(allowed),
  );
  it('fails closed on missing locks, fast consent and cap; validates inputs', () => {
    const valid = input('base', 'fast', { confirmations: 10 });
    expect(
      revealPolicy({ ...valid, evidence: { ...valid.evidence, exists: false } })
        .allowed,
    ).toBe(false);
    expect(revealPolicy({ ...valid, fastOptIn: false }).allowed).toBe(false);
    expect(revealPolicy({ ...valid, amountUsdMicros: 25000001n }).allowed).toBe(
      false,
    );
    expect(() => revealPolicy({ ...valid, amountUsdMicros: -1n })).toThrow();
    expect(() =>
      revealPolicy({
        ...valid,
        evidence: { ...valid.evidence, confirmations: -1 },
      }),
    ).toThrow();
    expect(() =>
      revealPolicy(valid, { ...DEFAULT_REVEAL_CONFIG, dsproofWindowMs: -1 }),
    ).toThrow();
  });
  it('rejects zero confirmation thresholds and invalid observation age', () => {
    const valid = input('base', 'fast', { confirmations: 10 });
    expect(() =>
      revealPolicy(valid, { ...DEFAULT_REVEAL_CONFIG, baseConfirmations: 0 }),
    ).toThrow();
    expect(() =>
      revealPolicy({
        ...valid,
        evidence: { ...valid.evidence, ageSeconds: -1 },
      }),
    ).toThrow();
  });
});
