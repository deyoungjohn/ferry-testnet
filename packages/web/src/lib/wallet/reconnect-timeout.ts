import { useEffect, useRef, useState } from 'react';

export const BCH_RECONNECT_TIMEOUT_MS = 8_000;

export function useBchReconnectTimeout(
  state: string,
  disconnect: () => Promise<unknown> | void,
  timeoutMs = BCH_RECONNECT_TIMEOUT_MS,
): boolean {
  const [timedOut, setTimedOut] = useState(false);
  const disconnectRef = useRef(disconnect);

  useEffect(() => {
    disconnectRef.current = disconnect;
  }, [disconnect]);

  useEffect(() => {
    if (state !== 'connecting' && state !== 'reconnecting') {
      setTimedOut(false);
      return;
    }
    setTimedOut(false);
    const timer = window.setTimeout(() => {
      setTimedOut(true);
      void Promise.resolve(disconnectRef.current()).catch(() => undefined);
    }, timeoutMs);
    return () => window.clearTimeout(timer);
  }, [state, timeoutMs]);

  return timedOut;
}
