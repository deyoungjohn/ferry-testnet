export const BCH_KEY_ROLES = [
  'SOLVER_BCH_WIF',
  'USER_BCH_WIF',
  'USER2_BCH_WIF',
] as const;

export type BchKeyRole = (typeof BCH_KEY_ROLES)[number];

export const EVM_KEY_ROLES = [
  'DEPLOYER_EVM_PRIVATE_KEY',
  'SOLVER_EVM_PRIVATE_KEY',
  'USER_EVM_PRIVATE_KEY',
  'USER2_EVM_PRIVATE_KEY',
] as const;

export type EvmKeyRole = (typeof EVM_KEY_ROLES)[number];

export const SOL_KEY_ROLES = [
  'DEPLOYER_SOL_KEYPAIR',
  'SOLVER_SOL_KEYPAIR',
  'USER_SOL_KEYPAIR',
] as const;

export type SolKeyRole = (typeof SOL_KEY_ROLES)[number];

export type KeyRole = BchKeyRole | EvmKeyRole | SolKeyRole;

export interface BchAddressInfo {
  plain: string;
  tokenAware: string;
}

export type AddressOrStatus<T> = T | 'INVALID' | null;

export interface RoleAddresses {
  bch: Record<BchKeyRole, AddressOrStatus<BchAddressInfo>>;
  evm: Record<EvmKeyRole, AddressOrStatus<string>>;
  sol: Record<SolKeyRole, AddressOrStatus<string>>;
}
