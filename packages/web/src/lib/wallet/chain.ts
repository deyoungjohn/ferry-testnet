export function isWrongEvmChain(
  chainId: number | undefined,
  expectedChainId: number,
): boolean {
  return chainId !== undefined && chainId !== expectedChainId;
}

export function wrongEvmChainMessage(expectedChainId: number): string {
  return `Switch your wallet to Base Sepolia (chain ${expectedChainId.toString()}).`;
}
