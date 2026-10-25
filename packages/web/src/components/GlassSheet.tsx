import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useState, type ReactNode } from 'react';
import { Drawer } from 'vaul';
import { useGlassLens } from '../lib/glass';
import { useGlassLayer } from '../lib/glass-layer';
import { XIcon } from './icons';

export interface GlassSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

export function GlassSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: GlassSheetProps) {
  const lensed = useGlassLens();
  const reducedMotion = useReducedMotion();
  const [animating, setAnimating] = useState(false);
  useGlassLayer(open, 'sheet');

  useEffect(() => {
    if (open) setAnimating(true);
  }, [open]);

  return (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange}
      shouldScaleBackground={false}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="glass-scrim fixed inset-0 z-50" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto w-full max-w-lg outline-none">
          <motion.div
            data-glass-panel="sheet"
            data-animating={animating ? 'true' : 'false'}
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 32 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
            transition={
              reducedMotion
                ? { duration: 0.12 }
                : { type: 'spring', stiffness: 420, damping: 34 }
            }
            onAnimationComplete={() => setAnimating(false)}
            className={[
              'glass glass-sheet glass-motion relative flex max-h-[90dvh] flex-col overflow-hidden rounded-t-card rounded-b-none border-b-0 px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] outline-none',
              lensed ? 'glass--lensed' : '',
            ].join(' ')}
          >
            <div
              aria-hidden="true"
              className="mx-auto mb-3 h-1.5 w-10 shrink-0 rounded-full bg-white/20"
            />
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Drawer.Title className="text-base font-semibold tracking-tight text-text">
                  {title}
                </Drawer.Title>
                {description ? (
                  <Drawer.Description className="mt-1 text-xs leading-5 text-text-muted">
                    {description}
                  </Drawer.Description>
                ) : null}
              </div>
              <Drawer.Close asChild>
                <button
                  type="button"
                  aria-label="Close"
                  className="grid size-8 shrink-0 place-items-center rounded-full border border-hairline bg-surface-2 text-text-muted transition-colors hover:text-text"
                >
                  <XIcon className="size-4" />
                </button>
              </Drawer.Close>
            </div>
            <div className="mt-4 min-h-0 overflow-y-auto">{children}</div>
            {footer ? <div className="mt-4 shrink-0">{footer}</div> : null}
          </motion.div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
