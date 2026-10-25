import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useState, type ReactNode } from 'react';
import { useGlassLens } from '../lib/glass';
import { useGlassLayer } from '../lib/glass-layer';
import { useMediaQuery } from '../lib/useMediaQuery';
import { GlassSheet } from './GlassSheet';
import { XIcon } from './icons';

export interface GlassModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

export function GlassModal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: GlassModalProps) {
  const mobile = useMediaQuery('(max-width: 767px)');
  const lensed = useGlassLens();
  const reducedMotion = useReducedMotion();
  const [animating, setAnimating] = useState(false);
  useGlassLayer(open && !mobile, 'modal');

  useEffect(() => {
    if (open) setAnimating(true);
  }, [open]);

  if (mobile) {
    return (
      <GlassSheet
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        {...(description ? { description } : {})}
        {...(footer ? { footer } : {})}
      >
        {children}
      </GlassSheet>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal forceMount>
        <AnimatePresence>
          {open ? (
            <>
              <Dialog.Overlay asChild forceMount>
                <motion.div
                  className="glass-scrim fixed inset-0 z-50"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reducedMotion ? 0.12 : 0.18 }}
                />
              </Dialog.Overlay>
              <Dialog.Content asChild forceMount>
                <motion.div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4 sm:p-6">
                  <motion.div
                    data-glass-panel="modal"
                    data-animating={animating ? 'true' : 'false'}
                    initial={
                      reducedMotion
                        ? { opacity: 0 }
                        : { opacity: 0, scale: 0.96, y: 12 }
                    }
                    animate={
                      reducedMotion
                        ? { opacity: 1 }
                        : { opacity: 1, scale: 1, y: 0 }
                    }
                    exit={
                      reducedMotion
                        ? { opacity: 0 }
                        : { opacity: 0, scale: 0.97, y: 8 }
                    }
                    transition={
                      reducedMotion
                        ? { duration: 0.12 }
                        : { type: 'spring', stiffness: 420, damping: 34 }
                    }
                    onAnimationComplete={() => setAnimating(false)}
                    className={[
                      'glass glass-modal glass-motion pointer-events-auto relative flex max-h-[min(90dvh,44rem)] w-full max-w-lg flex-col overflow-hidden p-5 outline-none sm:p-6',
                      lensed ? 'glass--lensed' : '',
                    ].join(' ')}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <Dialog.Title className="text-base font-semibold tracking-tight text-text">
                          {title}
                        </Dialog.Title>
                        {description ? (
                          <Dialog.Description className="mt-1 text-xs leading-5 text-text-muted">
                            {description}
                          </Dialog.Description>
                        ) : null}
                      </div>
                      <Dialog.Close asChild>
                        <button
                          type="button"
                          aria-label="Close"
                          className="grid size-8 shrink-0 place-items-center rounded-full border border-hairline bg-surface-2 text-text-muted transition-colors hover:text-text"
                        >
                          <XIcon className="size-4" />
                        </button>
                      </Dialog.Close>
                    </div>
                    <div className="mt-4 min-h-0 overflow-y-auto">
                      {children}
                    </div>
                    {footer ? (
                      <div className="mt-4 shrink-0">{footer}</div>
                    ) : null}
                  </motion.div>
                </motion.div>
              </Dialog.Content>
            </>
          ) : null}
        </AnimatePresence>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
