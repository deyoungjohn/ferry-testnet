import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useQuoteAutoRefresh } from '../lib/quote/auto-refresh';

function deferred(): {
  readonly promise: Promise<boolean>;
  readonly resolve: (ok: boolean) => void;
} {
  let resolve: (ok: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('quote auto-refresh', () => {
  it('refreshes a few seconds before expiry and exposes a visible state', async () => {
    const pending = deferred();
    const onRefresh = vi.fn(() => pending.promise);
    const { result } = renderHook(() =>
      useQuoteAutoRefresh({
        enabled: true,
        expiresAt: 60,
        leadSeconds: 5,
        onRefresh,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(54_900);
    });
    expect(onRefresh).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(result.current.refreshing).toBe(true);
    expect(result.current.attempts).toBe(1);

    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    expect(result.current.refreshing).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('does nothing after the lock starts or when disabled', async () => {
    const onRefresh = vi.fn(async () => true);
    const { rerender } = renderHook(
      ({ enabled }: { readonly enabled: boolean }) =>
        useQuoteAutoRefresh({
          enabled,
          expiresAt: 10,
          leadSeconds: 5,
          onRefresh,
        }),
      { initialProps: { enabled: false } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(onRefresh).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('stops after three attempts without user action', async () => {
    let expiry = 5;
    const onRefresh = vi.fn(async () => {
      expiry += 5;
      return true;
    });
    const { result, rerender } = renderHook(() =>
      useQuoteAutoRefresh({
        enabled: true,
        expiresAt: expiry,
        leadSeconds: 5,
        maxAttempts: 3,
        onRefresh,
      }),
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      rerender();
    }

    expect(onRefresh).toHaveBeenCalledTimes(3);
    expect(result.current.attempts).toBe(3);
    expect(result.current.stopped).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(onRefresh).toHaveBeenCalledTimes(3);
  });

  it('cancels an in-flight refresh and keeps reset explicit', async () => {
    const pending = deferred();
    const onRefresh = vi.fn(() => pending.promise);
    const { result } = renderHook(() =>
      useQuoteAutoRefresh({
        enabled: true,
        expiresAt: 5,
        leadSeconds: 5,
        onRefresh,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.refreshing).toBe(true);

    act(() => result.current.cancel());
    await act(async () => {
      pending.resolve(false);
      await pending.promise;
    });
    expect(result.current.refreshing).toBe(false);
    expect(result.current.stopped).toBe(false);

    act(() => result.current.reset());
    expect(result.current.attempts).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('reports a refresh failure and stops retrying', async () => {
    const onRefresh = vi.fn(async () => false);
    const { result } = renderHook(() =>
      useQuoteAutoRefresh({
        enabled: true,
        expiresAt: 5,
        leadSeconds: 5,
        onRefresh,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.error).toMatch(/could not be refreshed/i);
    expect(result.current.stopped).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
