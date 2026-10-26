import { API_ERROR_CODES } from '@ferry/core';
import { describe, expect, it } from 'vitest';
import { SolverError, describeSolverError } from '../lib/solver/errors';

describe('solver error copy', () => {
  it('maps every typed core error code to a sentence and next step', () => {
    for (const code of API_ERROR_CODES) {
      const failure = describeSolverError(new SolverError(code, code));
      expect(failure.sentence.length).toBeGreaterThan(10);
      expect(failure.nextStep.length).toBeGreaterThan(10);
      expect(failure.code).toBe(code);
      expect(failure.kind).toBe('solver');
    }
  });

  it('distinguishes an unreachable solver', () => {
    const failure = describeSolverError(
      new SolverError('UNREACHABLE', 'network failed'),
    );
    expect(failure.kind).toBe('unreachable');
    expect(failure.sentence).toMatch(/cannot reach the solver/i);
    expect(failure.nextStep).toMatch(/check that the solver is running/i);
  });

  it('keeps an unknown solver code reportable', () => {
    const failure = describeSolverError(
      new SolverError('UNKNOWN', 'future failure', 400, 'FUTURE_CODE'),
    );
    expect(failure.kind).toBe('unknown');
    expect(failure.sentence).toMatch(/unexpected error/i);
    expect(failure.code).toBe('FUTURE_CODE');
  });

  it('passes local messages through without inventing a code', () => {
    const failure = describeSolverError(new Error('User rejected.'));
    expect(failure.sentence).toBe('User rejected.');
    expect(failure.code).toBeNull();
    expect(failure.kind).toBe('local');
  });
});
