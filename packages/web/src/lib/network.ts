export type NetworkKind = 'testnet' | 'mainnet';

export interface NetworkLimits {
  readonly minUsdMicros: bigint;
  readonly maxUsdMicros: bigint;
  readonly fastLaneMaxUsdMicros: bigint;
}

export interface BaseNetworkProfile {
  readonly chainId: number;
  readonly chainName: string;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  readonly usdcAddress: string;
  readonly usdcDecimals: number;
  readonly usdcDomainName: string;
  readonly usdcDomainVersion: string;
  readonly htlcAddress: string;
  readonly htlcCodeHash: string;
  /** First block of the HTLC contract; history scans never go earlier. 0 = unknown. */
  readonly htlcDeployBlock: number;
}

export interface BchNetworkProfile {
  readonly network: 'chipnet' | 'mainnet';
  readonly prefix: 'bchtest' | 'bitcoincash';
  readonly chainName: string;
  readonly explorerUrl: string;
  readonly electrumUrls: readonly string[];
  readonly pusdCategory: string;
  readonly musdCategory: string;
  readonly pusdSymbol: string;
  readonly musdSymbol: string;
  readonly decimals: number;
  readonly mockUserAddress: string;
  readonly mockSolverAddress: string;
}

export interface NetworkProfile {
  readonly kind: NetworkKind;
  readonly label: string;
  readonly isMainnet: boolean;
  readonly base: BaseNetworkProfile;
  readonly bch: BchNetworkProfile;
  readonly solver: {
    readonly signingAddress: string;
    readonly bchAddress: string;
  };
  readonly limits: NetworkLimits;
  readonly citations: Readonly<Record<string, string>>;
}

const LIMITS: NetworkLimits = {
  minUsdMicros: 1_000_000n,
  maxUsdMicros: 50_000_000n,
  fastLaneMaxUsdMicros: 25_000_000n,
};

export const TESTNET_PROFILE: NetworkProfile = {
  kind: 'testnet',
  label: 'Testnet',
  isMainnet: false,
  base: {
    chainId: 84532,
    chainName: 'Base Sepolia',
    rpcUrl: 'https://sepolia.base.org',
    explorerUrl: 'https://sepolia.basescan.org',
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    usdcDecimals: 6,
    usdcDomainName: 'USDC',
    usdcDomainVersion: '2',
    htlcAddress: '0x5A0C062f4B7b8fF2263530e12bc15De9C836a641',
    htlcCodeHash:
      '0x684ed535a307fb57a0ee587c1421b9534a19138e2d18f8f91ab8ad3bc069440d',
    htlcDeployBlock: 49759583, // binary search of eth_getCode on Base Sepolia, 2026-11-05
  },
  bch: {
    network: 'chipnet',
    prefix: 'bchtest',
    chainName: 'BCH chipnet',
    explorerUrl: 'https://blockexplorer.cash/chipnet',
    electrumUrls: ['wss://chipnet.imaginary.cash:50004'],
    pusdCategory:
      '0xec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac',
    musdCategory:
      '0xc99627aec3e041f281068704c2609699d234586d5097301eff995f3bd00ac04d',
    pusdSymbol: 'tPUSD',
    musdSymbol: 'tMUSD',
    decimals: 2,
    mockUserAddress: 'bchtest:zznldca5825k6le8hpnwxhzugn82j2gm8uzgy6y6j8',
    mockSolverAddress: 'bchtest:zz3r8kfgl8qs94pyswepj6dylqf5avuf9ygs8308u4',
  },
  solver: {
    signingAddress: '0x1Ec1DB9462247d5A2F48C224472591e222A20aF2',
    bchAddress: 'bchtest:zz3r8kfgl8qs94pyswepj6dylqf5avuf9ygs8308u4',
  },
  limits: LIMITS,
  citations: {},
};

export const MAINNET_PROFILE: NetworkProfile = {
  kind: 'mainnet',
  label: 'Mainnet',
  isMainnet: true,
  base: {
    chainId: 8453, // FACT-A2-023
    chainName: 'Base',
    rpcUrl: '',
    explorerUrl: '',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // FACT-A3-069
    usdcDecimals: 6, // FACT-A3-069
    usdcDomainName: '',
    usdcDomainVersion: '',
    htlcAddress: '',
    htlcCodeHash: '',
    htlcDeployBlock: 0,
  },
  bch: {
    network: 'mainnet',
    prefix: 'bitcoincash',
    chainName: 'Bitcoin Cash mainnet',
    explorerUrl: '',
    electrumUrls: [
      // FACT-A3-076
      'wss://blackie.c3-soft.com:50004',
      'wss://bch.imaginary.cash:50004',
    ],
    pusdCategory: '',
    musdCategory: '',
    pusdSymbol: 'PUSD', // FACT-A3-075
    musdSymbol: 'MUSD', // FACT-A3-075
    decimals: 2, // FACT-A3-075
    mockUserAddress: '',
    mockSolverAddress: '',
  },
  solver: {
    signingAddress: '',
    bchAddress: '',
  },
  limits: LIMITS,
  citations: {
    'base.chainId': 'FACT-A2-023',
    'base.usdcAddress': 'FACT-A3-069',
    'base.usdcDecimals': 'FACT-A3-069',
    'bch.electrumUrls': 'FACT-A3-076',
    'bch.pusdSymbol': 'FACT-A3-075',
    'bch.musdSymbol': 'FACT-A3-075',
    'bch.decimals': 'FACT-A3-075',
  },
};

export type NetworkSetting = {
  readonly kind: NetworkKind;
  readonly error: string | null;
};

export function readNetworkSetting(value: string | undefined): NetworkSetting {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'testnet') {
    return { kind: 'testnet', error: null };
  }
  if (normalized === 'mainnet') {
    return { kind: 'mainnet', error: null };
  }
  return {
    kind: 'testnet',
    error: `VITE_NETWORK="${value ?? ''}" is not "testnet" or "mainnet"; refusing to start.`,
  };
}

function requiredErrors(profile: NetworkProfile): string[] {
  const errors: string[] = [];
  const required = (path: string, value: string | number): void => {
    if (typeof value === 'string' && value.trim().length === 0) {
      errors.push(`${profile.kind} profile is missing ${path}`);
    }
    if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) {
      errors.push(`${profile.kind} profile is missing ${path}`);
    }
  };
  required('base.chainId', profile.base.chainId);
  required('base.rpcUrl', profile.base.rpcUrl);
  required('base.explorerUrl', profile.base.explorerUrl);
  required('base.usdcAddress', profile.base.usdcAddress);
  required('base.usdcDecimals', profile.base.usdcDecimals);
  required('base.usdcDomainName', profile.base.usdcDomainName);
  required('base.usdcDomainVersion', profile.base.usdcDomainVersion);
  required('base.htlcAddress', profile.base.htlcAddress);
  required('base.htlcCodeHash', profile.base.htlcCodeHash);
  required('bch.explorerUrl', profile.bch.explorerUrl);
  required('bch.pusdCategory', profile.bch.pusdCategory);
  required('bch.musdCategory', profile.bch.musdCategory);
  required('bch.pusdSymbol', profile.bch.pusdSymbol);
  required('bch.musdSymbol', profile.bch.musdSymbol);
  required('bch.decimals', profile.bch.decimals);
  required('solver.signingAddress', profile.solver.signingAddress);
  required('solver.bchAddress', profile.solver.bchAddress);
  if (
    profile.bch.electrumUrls.length < (profile.isMainnet ? 2 : 1) ||
    profile.bch.electrumUrls.some((url) => url.trim().length === 0)
  ) {
    errors.push(
      `${profile.kind} profile needs ${profile.isMainnet ? 'two independent' : 'one'} BCH Electrum endpoint`,
    );
  }
  return errors;
}

export function networkConfigErrors(
  profile: NetworkProfile,
  settingError: string | null = null,
): readonly string[] {
  return [...(settingError ? [settingError] : []), ...requiredErrors(profile)];
}

export function citationsForNonEmptyValues(
  profile: NetworkProfile,
): readonly string[] {
  const valueAt = (path: string): unknown => {
    const [group, key] = path.split('.') as [string, string];
    const groupValue = profile[group as keyof NetworkProfile];
    return groupValue && typeof groupValue === 'object'
      ? (groupValue as Record<string, unknown>)[key]
      : undefined;
  };
  return Object.entries(profile.citations)
    .filter(([, fact]) => /^FACT-[A-Z0-9]+-\d+$/.test(fact))
    .filter(([path]) => {
      const value = valueAt(path);
      return Array.isArray(value)
        ? value.length > 0
        : typeof value === 'bigint'
          ? value !== 0n
          : Boolean(value);
    })
    .map(([, fact]) => fact);
}
