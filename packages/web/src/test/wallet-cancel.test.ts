import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useBchReconnectTimeout } from '../lib/wallet/reconnect-timeout';

describe('QR pairing timeout', () => {
  it('drops a restored session after the limit but not a pairing the user started', () => {
    vi.useFakeTimers();
    const disconnect = vi.fn();
    const restored = renderHook(() =>
      useBchReconnectTimeout('connecting', disconnect, 8_000, true),
    );
    const started = renderHook(() =>
      useBchReconnectTimeout('connecting', disconnect, 8_000, false),
    );
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(restored.result.current).toBe(true);
    expect(started.result.current).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
