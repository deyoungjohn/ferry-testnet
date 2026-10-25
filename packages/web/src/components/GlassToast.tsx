import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useGlassLens } from '../lib/glass';
import { useGlassLayer } from '../lib/glass-layer';
import {
  ToastContext,
  type ToastContextValue,
  type ToastTone,
} from '../lib/toast';
import { XIcon } from './icons';

interface ToastMessage {
  readonly id: number;
  readonly message: string;
  readonly tone: ToastTone;
}

function GlassToast({
  message,
  tone,
  onDismiss,
}: {
  readonly message: string;
  readonly tone: ToastTone;
  readonly onDismiss: () => void;
}) {
  const lensed = useGlassLens();

  return (
    <div
      data-glass-panel="toast"
      role={tone === 'error' ? 'alert' : 'status'}
      className={[
        'glass glass-toast glass-toast-in pointer-events-none flex w-full max-w-md items-start gap-3 rounded-well px-4 py-3 text-xs leading-5 text-text shadow-elev-card',
        lensed ? 'glass--lensed' : '',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={[
          'mt-1.5 size-1.5 shrink-0 rounded-full',
          tone === 'success'
            ? 'bg-ok'
            : tone === 'error'
              ? 'bg-danger'
              : 'bg-lime',
        ].join(' ')}
      />
      <p className="min-w-0 flex-1">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="pointer-events-auto grid size-6 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:text-text"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const nextId = useRef(0);
  const timer = useRef<number | null>(null);
  useGlassLayer(Boolean(toast), 'toast');

  const dismiss = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setToast(null);
  }, []);

  const push = useCallback((message: string, tone: ToastTone = 'info') => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    nextId.current += 1;
    setToast({ id: nextId.current, message, tone });
    timer.current = window.setTimeout(() => {
      setToast(null);
      timer.current = null;
    }, 4_500);
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const value = useMemo<ToastContextValue>(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[80] flex justify-center px-4">
        {toast ? (
          <GlassToast
            key={toast.id}
            message={toast.message}
            tone={toast.tone}
            onDismiss={dismiss}
          />
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}
