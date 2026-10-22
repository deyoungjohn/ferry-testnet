// Synthetic public addresses/categories; no deployed-contract claim is implied.
export const baseTerms = {
  version: 1, direction: 'COUNTER_TO_BCH', bchToken: 'PUSD',
  bchTokenCategory: `0x${'ab'.repeat(32)}`, bchTokenAmount: 2485n,
  counterAmount: 25000000n, counterChain: 'base', counterNetworkId: 84532,
  counterAsset: {symbol:'USDC',decimals:6,address:`0x${'11'.repeat(20)}`},
  counterHtlc:`0x${'22'.repeat(20)}`,userCounterAddress:`0x${'33'.repeat(20)}`,
  userBchLockingBytecode:`0x76a914${'44'.repeat(20)}88ac`,
  solverCounterAddress:`0x${'55'.repeat(20)}`,
  solverBchLockingBytecode:`0x76a914${'66'.repeat(20)}88ac`,
  hashLock:`0x${'77'.repeat(32)}`, counterDeadline:1800086400, bchRefundHeight:1000036,
  bchCarrySats:3000n,bchMaxFee:1500n,quoteId:'fixture-forward',quoteExpiry:1800000060,
} as const;
