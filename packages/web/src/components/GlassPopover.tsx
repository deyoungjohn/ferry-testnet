import * as Popover from '@radix-ui/react-popover';
import { useState, type ReactNode } from 'react';
import { useGlassLens } from '../lib/glass';
import { useGlassLayer } from '../lib/glass-layer';

export interface GlassPopoverProps {
  readonly trigger: ReactNode;
  readonly label: string;
  readonly children: ReactNode;
  readonly align?: 'start' | 'center' | 'end';
}

export function GlassPopover({
  trigger,
  label,
  children,
  align = 'end',
}: GlassPopoverProps) {
  const [open, setOpen] = useState(false);
  const lensed = useGlassLens();
  useGlassLayer(open, 'popover');

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          aria-label={label}
          sideOffset={8}
          align={align}
          collisionPadding={12}
          className={[
            'glass glass-popover z-[60] w-72 rounded-well p-3.5 text-xs leading-5 text-text-muted shadow-elev-pill outline-none',
            lensed ? 'glass--lensed' : '',
          ].join(' ')}
        >
          {children}
          <Popover.Arrow className="fill-white/10" width={12} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
