import { createPublicClient, http, erc20Abi, formatEther, formatUnits } from 'viem';
import { baseSepolia } from 'viem/chains';

export const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

export interface EvmBalanceResult {
  address: `0x${string}`;
  ethWei: bigint;
  ethFormatted: string;
  usdcRaw: bigint;
  usdcFormatted: string;
}

export class EvmClient {
  private client;
  private usdcAddress: `0x${string}`;

  constructor(rpcUrl: string = 'https://sepolia.base.org', usdcAddress: `0x${string}` = BASE_SEPOLIA_USDC) {
    this.client = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl)
    });
    this.usdcAddress = usdcAddress;
  }

  async getBalances(address: `0x${string}`): Promise<EvmBalanceResult> {
    const [ethWei, usdcRaw] = await Promise.all([
      this.client.getBalance({ address }),
      this.client.readContract({
        address: this.usdcAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address]
      })
    ]);

    return {
      address,
      ethWei,
      ethFormatted: formatEther(ethWei),
      usdcRaw,
      usdcFormatted: formatUnits(usdcRaw, 6)
    };
  }
}
