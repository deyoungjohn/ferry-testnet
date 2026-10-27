// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NetworkBanner } from '../components/NetworkBanner';
import { NetworkBlockedPage } from '../components/NetworkBlockedPage';
import {
  NETWORK_CONFIG_ERRORS,
  NETWORK_KIND,
  NETWORK_LABEL,
  NETWORK_PROFILE,
} from '../lib/config';
import {
  MAINNET_PROFILE,
  TESTNET_PROFILE,
  citationsForNonEmptyValues,
  networkConfigErrors,
  readNetworkSetting,
} from '../lib/network';

afterEach(cleanup);

describe('network profiles', () => {
  it('defaults to the testnet profile with no configuration errors', () => {
    expect(NETWORK_KIND).toBe('testnet');
    expect(NETWORK_PROFILE).toBe(TESTNET_PROFILE);
    expect(NETWORK_LABEL).toBe('Testnet');
    expect(NETWORK_CONFIG_ERRORS).toEqual([]);
  });

  it('never mixes testnet and mainnet values', () => {
    const fingerprints = [
      {
        profile: TESTNET_PROFILE,
        kind: 'testnet',
        chainId: 84532,
        chainName: 'Base Sepolia',
        usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        bchNetwork: 'chipnet',
        prefix: 'bchtest',
        symbol: 'tPUSD',
        solver: '0x1Ec1DB9462247d5A2F48C224472591e222A20aF2',
        fmt: 'https://blockexplorer.cash/chipnet',
      },
      {
        profile: MAINNET_PROFILE,
        kind: 'mainnet',
        chainId: 8453,
        chainName: 'Base',
        usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        bchNetwork: 'mainnet',
        prefix: 'bitcoincash',
        symbol: 'PUSD',
        solver: '',
        fmt: '',
      },
    ] as const;
    for (const expected of fingerprints) {
      expect(expected.profile.kind).toBe(expected.kind);
      expect(expected.profile.base.chainId).toBe(expected.chainId);
      expect(expected.profile.base.chainName).toBe(expected.chainName);
      expect(expected.profile.base.usdcAddress).toBe(expected.usdc);
      expect(expected.profile.bch.network).toBe(expected.bchNetwork);
      expect(expected.profile.bch.prefix).toBe(expected.prefix);
      expect(expected.profile.bch.pusdSymbol).toBe(expected.symbol);
      expect(expected.profile.solver.signingAddress).toBe(expected.solver);
      expect(expected.profile.bch.explorerUrl).toBe(expected.fmt);
    }
    expect(MAINNET_PROFILE.bch.pusdCategory).toBe('');
    expect(MAINNET_PROFILE.bch.musdCategory).toBe('');
  });

  it('keeps the existing swap caps on both profiles', () => {
    for (const profile of [TESTNET_PROFILE, MAINNET_PROFILE]) {
      expect(profile.limits.minUsdMicros).toBe(1_000_000n);
      expect(profile.limits.maxUsdMicros).toBe(50_000_000n);
      expect(profile.limits.fastLaneMaxUsdMicros).toBe(25_000_000n);
    }
  });

  it('fails closed on missing or unverified mainnet values', () => {
    const errors = networkConfigErrors(MAINNET_PROFILE);
    expect(errors).toContain('mainnet profile is missing base.rpcUrl');
    expect(errors).toContain('mainnet profile is missing base.htlcAddress');
    expect(errors).toContain('mainnet profile is missing bch.pusdCategory');
    expect(errors).toContain('mainnet profile is missing bch.musdCategory');
    expect(errors).toContain(
      'mainnet profile is missing solver.signingAddress',
    );
    expect(errors).not.toContain('mainnet profile is missing base.usdcAddress');
  });

  it('cites a verified FACT for every non-empty mainnet value it claims', () => {
    const facts = citationsForNonEmptyValues(MAINNET_PROFILE);
    expect(facts).toEqual(
      expect.arrayContaining([
        'FACT-A2-023',
        'FACT-A3-069',
        'FACT-A3-076',
        'FACT-A3-075',
      ]),
    );
    expect(MAINNET_PROFILE.citations['base.chainId']).toBe('FACT-A2-023');
    expect(MAINNET_PROFILE.citations['base.usdcAddress']).toBe('FACT-A3-069');
    expect(MAINNET_PROFILE.citations['bch.electrumUrls']).toBe('FACT-A3-076');
    expect(MAINNET_PROFILE.citations['bch.pusdSymbol']).toBe('FACT-A3-075');
  });

  it('treats an unknown build-time network as a blocking error', () => {
    const setting = readNetworkSetting('devnet');
    expect(setting.kind).toBe('testnet');
    expect(setting.error).toMatch(/not "testnet" or "mainnet"/);
  });
});

describe('mainnet UI state', () => {
  it('always shows a prominent real-funds banner on mainnet', () => {
    render(<NetworkBanner profile={MAINNET_PROFILE} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      /mainnet · real funds · irreversible/i,
    );
  });

  it('does not show the mainnet banner on testnet', () => {
    render(<NetworkBanner profile={TESTNET_PROFILE} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a blocking page instead of the swap UI when mainnet is incomplete', () => {
    render(<NetworkBlockedPage profile={MAINNET_PROFILE} />);
    expect(
      screen.getByRole('heading', {
        name: /mainnet is not configured for real funds/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/no funds can move/i)).toBeInTheDocument();
    expect(
      screen.getByText(/mainnet profile is missing bch.pusdCategory/i),
    ).toBeInTheDocument();
  });
});
