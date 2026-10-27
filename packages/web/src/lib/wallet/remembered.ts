import type { BchAddressInfo } from '../bch/address';

const KEY = 'ferry-bch-wallet-v1';

export interface RememberedBchWallet {
  readonly name: string | null;
  readonly address: BchAddressInfo;
  readonly savedAt: number;
}

export function readRememberedBchWallet(): RememberedBchWallet | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedBchWallet>;
    if (
      typeof parsed.savedAt !== 'number' ||
      !parsed.address ||
      typeof parsed.address.address !== 'string' ||
      typeof parsed.address.lockingBytecode !== 'string' ||
      !/^0x[0-9a-fA-F]+$/.test(parsed.address.lockingBytecode)
    ) {
      return null;
    }
    return {
      name: typeof parsed.name === 'string' ? parsed.name : null,
      address: {
        address: parsed.address.address,
        lockingBytecode: parsed.address
          .lockingBytecode as BchAddressInfo['lockingBytecode'],
        tokenAware: true,
      },
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
}

export function saveRememberedBchWallet(
  name: string | null,
  address: BchAddressInfo,
): RememberedBchWallet {
  const remembered: RememberedBchWallet = {
    name,
    address: { ...address, tokenAware: true },
    savedAt: Math.floor(Date.now() / 1_000),
  };
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(KEY, JSON.stringify(remembered));
  }
  return remembered;
}

export function clearRememberedBchWallet(): void {
  if (typeof window !== 'undefined') window.localStorage.removeItem(KEY);
}
