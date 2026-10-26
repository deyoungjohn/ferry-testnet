import { useCallback, useEffect, useRef, useState } from 'react';

export interface QuoteAutoRefreshState {
  readonly refreshing: boolean;
  readonly error: string | null;
  readonly attempts: number;
  readonly stopped: boolean;
}

export interface QuoteAutoRefreshOptions {
  readonly enabled: boolean;
  readonly expiresAt: number | null;
  readonly leadSeconds?: number;
  readonly maxAttempts?: number;
  readonly onRefresh: () => Promise<boolean>;
}

const INITIAL_STATE: QuoteAutoRefreshState = {
  refreshing: false,
  error: null,
  attempts: 0,
  stopped: false,
};

function errorMessage(cause: unknown): string {
  if (cause !== null && typeof cause === 'object' && 'message' in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'The quote expired and could not be refreshed.';
}

export function useQuoteAutoRefresh({
  enabled,
  expiresAt,
  leadSeconds = 5,
  maxAttempts = 3,
  onRefresh,
}: QuoteAutoRefreshOptions): QuoteAutoRefreshState & {
  readonly reset: () => void;
  readonly cancel: () => void;
} {
  const [state, setState] = useState<QuoteAutoRefreshState>(INITIAL_STATE);
  const attempts = useRef(0);
  const lastAttemptedExpiry = useRef<number | null>(null);
  const generation = useRef(0);
  const timer = useRef<number | null>(null);
  const refreshRef = useRef(onRefresh);

  useEffect(() => {
    refreshRef.current = onRefresh;
  }, [onRefresh]);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    generation.current += 1;
    attempts.current = 0;
    lastAttemptedExpiry.current = null;
    clearTimer();
    setState(INITIAL_STATE);
  }, [clearTimer]);

  const cancel = useCallback(() => {
    generation.current += 1;
    clearTimer();
    setState((current) => ({ ...current, refreshing: false }));
  }, [clearTimer]);

  useEffect(() => {
    clearTimer();
    if (!enabled || expiresAt === null || state.stopped) return;
    if (lastAttemptedExpiry.current === expiresAt) return;
    if (attempts.current >= maxAttempts) {
      setState((current) => ({ ...current, stopped: true }));
      return;
    }

    const delayMs = Math.max(
      0,
      (expiresAt - leadSeconds - Date.now() / 1_000) * 1_000,
    );
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (lastAttemptedExpiry.current === expiresAt) return;
      if (attempts.current >= maxAttempts) {
        setState((current) => ({ ...current, stopped: true }));
        return;
      }

      lastAttemptedExpiry.current = expiresAt;
      attempts.current += 1;
      const attempt = attempts.current;
      const generationAtStart = generation.current;
      setState({
        refreshing: true,
        error: null,
        attempts: attempt,
        stopped: attempt >= maxAttempts,
      });

      void refreshRef
        .current()
        .then((ok) => {
          if (generationAtStart !== generation.current) return;
          setState({
            refreshing: false,
            error: ok
              ? null
              : 'The quote expired and could not be refreshed automatically. Get a new quote.',
            attempts: attempt,
            stopped: !ok || attempt >= maxAttempts,
          });
        })
        .catch((cause: unknown) => {
          if (generationAtStart !== generation.current) return;
          setState({
            refreshing: false,
            error: errorMessage(cause),
            attempts: attempt,
            stopped: true,
          });
        });
    }, delayMs);

    return clearTimer;
  }, [
    attempts,
    clearTimer,
    enabled,
    expiresAt,
    leadSeconds,
    maxAttempts,
    state.stopped,
  ]);

  return { ...state, reset, cancel };
}
