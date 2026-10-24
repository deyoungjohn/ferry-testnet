import { expect, it } from 'vitest';
import { VERSION, orderId } from '@ferry/core';
import { baseTerms } from './fixtures/terms.js';
it('resolves the package source condition without built dist', () => {
  expect(VERSION).toBe('0.0.0');
  expect(orderId(baseTerms)).toMatch(/^0x[0-9a-f]{64}$/);
});
