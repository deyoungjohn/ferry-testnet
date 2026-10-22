import { describe, expect, it } from 'vitest';
import { hashTypedData, hexToBytes, sha256 } from 'viem';
import { evmLockId, lockIntentTypedData, lockIntentDomainSeparator, LOCK_INTENT_TYPEHASH } from '../src/evm.js';
import { categoryDisplayToInternal, categoryInternalToDisplay } from '../src/category.js';
const hashLock=sha256(hexToBytes(`0x${'01'.repeat(32)}`));
const domain={chainId:84532,verifyingContract:'0x1111111111111111111111111111111111111111'} as const;
const message={token:'0x036cbd53842c5426634e7929541ec2318f3dcf7e',recipient:'0x2222222222222222222222222222222222222222',amount:25000000n,hashLock,deadline:1800000000n,intentDeadline:1799990000n} as const;
describe('independent XV vectors',()=>{
 it('matches committed XV-001..004 results',async()=>{
  const expected=(await import('./fixtures/cross-check.json')).default;
  expect(hashLock).toBe(expected.hashLock);
  expect(evmLockId('0x3333333333333333333333333333333333333333',hashLock)).toBe(expected.lockId);
  expect(LOCK_INTENT_TYPEHASH).toBe(expected.typeHash);
  expect(lockIntentDomainSeparator(domain)).toBe(expected.domainSeparator);
  expect(hashTypedData(lockIntentTypedData(domain,message))).toBe(expected.digest);
  expect(categoryDisplayToInternal('2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544')).toBe(expected.internalCategory);
  expect(categoryInternalToDisplay(expected.internalCategory)).toBe('0x2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544');
 });
 it('validates lengths, EVM domain and uint ranges',()=>{
  expect(()=>categoryDisplayToInternal('00')).toThrow();
  expect(()=>categoryInternalToDisplay('0xzz')).toThrow();
  expect(()=>evmLockId('0x00',hashLock)).toThrow();
  expect(()=>evmLockId(message.token,'0x00')).toThrow();
  expect(()=>lockIntentTypedData({...domain,chainId:0},message)).toThrow();
  expect(()=>lockIntentDomainSeparator({...domain,verifyingContract:'0x00'})).toThrow();
  for(const patch of [{amount:0n},{deadline:1n<<64n},{intentDeadline:-1n},{token:'0x00'},{hashLock:'0x00'}]) expect(()=>lockIntentTypedData(domain,{...message,...patch})).toThrow();
 });
});
