import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';

describe('@ferry/core scaffold', () => {
  it('exports the initial package version', () => {
    expect(VERSION).toBe('0.0.0');
  });
});
