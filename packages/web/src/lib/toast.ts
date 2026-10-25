import { createContext, useContext } from 'react';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastContextValue {
  readonly push: (message: string, tone?: ToastTone) => void;
}

export const ToastContext = createContext<ToastContextValue>({
  push: () => undefined,
});

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}
