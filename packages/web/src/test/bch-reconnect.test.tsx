import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BCH_RECONNECT_TIMEOUT_MS,
  useBchReconnectTimeout,
} from '../lib/wallet/reconnect-timeout';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BCH restored-session timeout', () => {
  it('drops a session that stays reconnecting for eight seconds', async () => {
    const disconnect = vi.fn(async () => undefined);
    const { result } = renderHook(
      ({ state }: { readonly state: string }) =>
        useBchReconnectTimeout(state, disconnect),
      { initialProps: { state: 'reconnecting' } },
    );

    expect(result.current).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BCH_RECONNECT_TIMEOUT_MS - 1);
    });
    expect(result.current).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current).toBe(true);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not cancel a fresh QR connection', async () => {
    const disconnect = vi.fn(async () => undefined);
    renderHook(() =>
      useBchReconnectTimeout('connecting', disconnect, undefined, false),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BCH_RECONNECT_TIMEOUT_MS * 2);
    });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('clears the timeout once the wallet connects', async () => {
    const disconnect = vi.fn(async () => undefined);
    const { result, rerender } = renderHook(
      ({ state }: { readonly state: string }) =>
        useBchReconnectTimeout(state, disconnect),
      { initialProps: { state: 'reconnecting' } },
    );

    rerender({ state: 'connected' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BCH_RECONNECT_TIMEOUT_MS * 2);
    });

    expect(result.current).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
  });
});
