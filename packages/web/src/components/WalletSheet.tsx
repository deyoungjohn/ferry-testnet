import { BASE_CHAIN_NAME } from '../lib/config';
import { GlassModal } from './GlassModal';
import { WalletPanel } from './WalletPanel';

export interface WalletSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function WalletSheet({ open, onOpenChange }: WalletSheetProps) {
  return (
    <GlassModal
      open={open}
      onOpenChange={onOpenChange}
      title="Connect wallets"
      description={`BCH wallet first, then a ${BASE_CHAIN_NAME} wallet. Ferry never asks for a private key.`}
    >
      <WalletPanel />
    </GlassModal>
  );
}
