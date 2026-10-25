import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { localhost } from 'viem/chains';

const ANVIL_PORT = 8547; // reserved Anvil port
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;

// Load compiled artifacts from forge build (standard EVM bytecode for local anvil testing)
const ferryArtifact = JSON.parse(
  readFileSync(
    resolve(__dirname, '../out/FerryHTLC.sol/FerryHTLC.json'),
    'utf8',
  ),
);
const mockTrc20Artifact = JSON.parse(
  readFileSync(
    resolve(__dirname, '../out/MockTRC20.sol/MockTRC20.json'),
    'utf8',
  ),
);
const mockNoReturnArtifact = JSON.parse(
  readFileSync(
    resolve(__dirname, '../out/MockNoReturnTRC20.sol/MockNoReturnTRC20.json'),
    'utf8',
  ),
);

function sha256(data: Uint8Array): `0x${string}` {
  return `0x${createHash('sha256').update(data).digest('hex')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('FerryHTLC Tron Port & USDT Non-Standard Return Quirk', () => {
  let anvilProcess: ChildProcess;
  let publicClient: ReturnType<typeof createPublicClient>;

  // Accounts from anvil default keys
  const deployerAccount = privateKeyToAccount(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  );
  const userAccount = privateKeyToAccount(
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  );
  const solverAccount = privateKeyToAccount(
    '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  );

  const createClient = (account: ReturnType<typeof privateKeyToAccount>) =>
    createWalletClient({
      account,
      chain: localhost,
      transport: http(RPC_URL),
    });

  type TestWalletClient = ReturnType<typeof createClient>;
  let deployerClient: TestWalletClient;
  let userClient: TestWalletClient;
  let solverClient: TestWalletClient;

  let htlcAddress: Address;
  let standardTokenAddress: Address;
  let noReturnTokenAddress: Address;

  beforeAll(async () => {
    // Spawn anvil on port 8547
    anvilProcess = spawn(
      'anvil',
      ['--port', String(ANVIL_PORT), '--chain-id', '31337', '--silent'],
      { stdio: 'ignore' },
    );

    publicClient = createPublicClient({
      chain: localhost,
      transport: http(RPC_URL),
    });

    let attempts = 0;
    while (attempts < 30) {
      try {
        await publicClient.getBlockNumber();
        break;
      } catch {
        await sleep(200);
        attempts++;
      }
    }

    deployerClient = createClient(deployerAccount);
    userClient = createClient(userAccount);
    solverClient = createClient(solverAccount);

    // Deploy FerryHTLC
    const htlcDeployHash = await deployerClient.deployContract({
      abi: ferryArtifact.abi,
      bytecode: (ferryArtifact.bytecode.object ||
        ferryArtifact.bytecode) as Hex,
    });
    const htlcReceipt = await publicClient.waitForTransactionReceipt({
      hash: htlcDeployHash,
    });
    htlcAddress = htlcReceipt.contractAddress!;

    // Deploy standard MockTRC20
    const standardDeployHash = await deployerClient.deployContract({
      abi: mockTrc20Artifact.abi,
      bytecode: (mockTrc20Artifact.bytecode.object ||
        mockTrc20Artifact.bytecode) as Hex,
      args: ['Standard TRC20', 'TRC', 6],
    });
    const standardReceipt = await publicClient.waitForTransactionReceipt({
      hash: standardDeployHash,
    });
    standardTokenAddress = standardReceipt.contractAddress!;

    // Deploy MockNoReturnTRC20 (mimics Tether USDT return-value quirk)
    const noReturnDeployHash = await deployerClient.deployContract({
      abi: mockNoReturnArtifact.abi,
      bytecode: (mockNoReturnArtifact.bytecode.object ||
        mockNoReturnArtifact.bytecode) as Hex,
      args: ['Tether USD', 'USDT', 6],
    });
    const noReturnReceipt = await publicClient.waitForTransactionReceipt({
      hash: noReturnDeployHash,
    });
    noReturnTokenAddress = noReturnReceipt.contractAddress!;

    // Mint tokens to User and Solver
    await deployerClient.writeContract({
      address: standardTokenAddress,
      abi: mockTrc20Artifact.abi,
      functionName: 'mint',
      args: [userAccount.address, 10_000_000n],
    });
    await deployerClient.writeContract({
      address: noReturnTokenAddress,
      abi: mockNoReturnArtifact.abi,
      functionName: 'mint',
      args: [userAccount.address, 10_000_000n],
    });
    await deployerClient.writeContract({
      address: noReturnTokenAddress,
      abi: mockNoReturnArtifact.abi,
      functionName: 'mint',
      args: [solverAccount.address, 10_000_000n],
    });
  }, 20000);

  afterAll(() => {
    if (anvilProcess) {
      anvilProcess.kill('SIGTERM');
    }
  });

  describe('Standard TRC-20 Flow', () => {
    it('executes lock and claim happy path', async () => {
      const secret = randomBytes(32);
      const hashLock = sha256(secret);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const amount = 1_000_000n;

      // User approves HTLC
      await userClient.writeContract({
        address: standardTokenAddress,
        abi: mockTrc20Artifact.abi,
        functionName: 'approve',
        args: [htlcAddress, amount],
      });

      // User locks tokens
      const lockHash = await userClient.writeContract({
        address: htlcAddress,
        abi: ferryArtifact.abi,
        functionName: 'lock',
        args: [
          standardTokenAddress,
          solverAccount.address,
          amount,
          hashLock,
          deadline,
        ],
      });
      await publicClient.waitForTransactionReceipt({ hash: lockHash });

      // Compute lockId
      const lockId = (await publicClient.readContract({
        address: htlcAddress,
        abi: ferryArtifact.abi,
        functionName: 'lockId',
        args: [userAccount.address, hashLock],
      })) as Hex;

      // Solver claims tokens with secret
      const claimHash = await solverClient.writeContract({
        address: htlcAddress,
        abi: ferryArtifact.abi,
        functionName: 'claim',
        args: [lockId, `0x${secret.toString('hex')}`],
      });
      await publicClient.waitForTransactionReceipt({ hash: claimHash });

      // Verify solver received tokens
      const solverBal = (await publicClient.readContract({
        address: standardTokenAddress,
        abi: mockTrc20Artifact.abi,
        functionName: 'balanceOf',
        args: [solverAccount.address],
      })) as bigint;
      expect(solverBal).toBe(amount);
    });

    it('rejects claim with wrong secret (BadSecret)', async () => {
      const secret = randomBytes(32);
      const wrongSecret = randomBytes(32);
      const hashLock = sha256(secret);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const amount = 500_000n;

      await userClient.writeContract({
        address: standardTokenAddress,
        abi: mockTrc20Artifact.abi,
        functionName: 'approve',
        args: [htlcAddress, amount],
      });

      await userClient.writeContract({
        address: htlcAddress,
        abi: ferryArtifact.abi,
        functionName: 'lock',
        args: [
          standardTokenAddress,
          solverAccount.address,
          amount,
          hashLock,
          deadline,
        ],
      });

      const lockId = (await publicClient.readContract({
        address: htlcAddress,
        abi: ferryArtifact.abi,
        functionName: 'lockId',
        args: [userAccount.address, hashLock],
      })) as Hex;

      await expect(
        solverClient.writeContract({
          address: htlcAddress,
          abi: ferryArtifact.abi,
          functionName: 'claim',
          args: [lockId, `0x${wrongSecret.toString('hex')}`],
        }),
      ).rejects.toThrow();
    });

    it('rejects double claim (NotLocked)', async () => {
      const secret = randomBytes(32);
      const hashLock = sha256(secret);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const amount = 200_000n;

      await userClient.writeContract({
        address: standardTokenAddress,
        abi: mockTrc20Artifact.abi,
        functionName: 'approve',
        args: [htlcAddress, amount],
      });

      await userClient.writeContract({
        address: htlcAddress,
        abi: ferryArtifact.abi,
        functionName: 'lock',
        args: [
          standardTokenAddress,
          solverAccount.address,
          amount,
          hashLock,
          deadline,
        ],
      });

      const lockId = (await publicClient.readContract({
        address: htlcAddress,
        abi: ferryArtifact.abi,
        functionName: 'lockId',
        args: [userAccount.address, hashLock],
      })) as Hex;

      const secretHex = `0x${secret.toString('hex')}`;
      const claimHash = await solverClient.writeContract({
        address: htlcAddress,
        abi: ferryArtifact.abi,
        functionName: 'claim',
        args: [lockId, secretHex],
      });
      await publicClient.waitForTransactionReceipt({ hash: claimHash });

      // Second claim must revert
      await expect(
        solverClient.writeContract({
          address: htlcAddress,
          abi: ferryArtifact.abi,
          functionName: 'claim',
          args: [lockId, secretHex],
        }),
      ).rejects.toThrow();
    });

    it('rejects premature refund (TooEarly) and succeeds after deadline', async () => {
      const secret = randomBytes(32);
      const hashLock = sha256(secret);
      // Deadline in 3 seconds
      const currentBlock = await publicClient.getBlock();
      const deadline = currentBlock.timestamp + 4n;
      const amount = 300_000n;

      await userClient.writeContract({
        address: standardTokenAddress,
        abi: mockTrc20Artifact.abi,
        functionName: 'approve',
        args: [htlcAddress, amount],
      });

      await userClient.writeContract({
        address: htlcAddress,
        abi: ferryArtifact.abi,
        functionName: 'lock',
        args: [
          standardTokenAddress,
          solverAccount.address,
          amount,
          hashLock,
          deadline,
        ],
      });

      const lockId = (await publicClient.readContract({
        address: htlcAddress,
        abi: ferryArtifact.abi,
        functionName: 'lockId',
        args: [userAccount.address, hashLock],
      })) as Hex;

      // Premature refund must revert
      await expect(
        userClient.writeContract({
          address: htlcAddress,
          abi: ferryArtifact.abi,
          functionName: 'refund',
          args: [lockId],
        }),
      ).rejects.toThrow();

      // Advance anvil time
      await publicClient.request({
        method: 'evm_increaseTime' as never,
        params: [5] as never,
      });
      await publicClient.request({
        method: 'evm_mine' as never,
        params: [] as never,
      });

      const userBalBefore = (await publicClient.readContract({
        address: standardTokenAddress,
        abi: mockTrc20Artifact.abi,
        functionName: 'balanceOf',
        args: [userAccount.address],
      })) as bigint;

      // Refund succeeds
      const refundHash = await userClient.writeContract({
        address: htlcAddress,
        abi: ferryArtifact.abi,
        functionName: 'refund',
        args: [lockId],
      });
      await publicClient.waitForTransactionReceipt({ hash: refundHash });

      const userBalAfter = (await publicClient.readContract({
        address: standardTokenAddress,
        abi: mockTrc20Artifact.abi,
        functionName: 'balanceOf',
        args: [userAccount.address],
      })) as bigint;
      expect(userBalAfter).toBe(userBalBefore + amount);

      // Double refund reverts
      await expect(
        userClient.writeContract({
          address: htlcAddress,
          abi: ferryArtifact.abi,
          functionName: 'refund',
          args: [lockId],
        }),
      ).rejects.toThrow();
    });
  });

  describe('Tron USDT Non-Standard Return Quirk (Void Return Handling)', () => {
    it('safely locks and claims token with void-return transfer/transferFrom (MockNoReturnTRC20)', async () => {
      const secret = randomBytes(32);
      const hashLock = sha256(secret);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const amount = 1_500_000n;

      // User approves HTLC on no-return TRC20 (USDT mock)
      await userClient.writeContract({
        address: noReturnTokenAddress,
        abi: mockNoReturnArtifact.abi,
        functionName: 'approve',
        args: [htlcAddress, amount],
      });

      // User locks tokens - SafeERC20 handles void transferFrom without reverting!
      const lockHash = await userClient.writeContract({
        address: htlcAddress,
        abi: ferryArtifact.abi,
        functionName: 'lock',
        args: [
          noReturnTokenAddress,
          solverAccount.address,
          amount,
          hashLock,
          deadline,
        ],
      });
      const lockReceipt = await publicClient.waitForTransactionReceipt({
        hash: lockHash,
      });
      expect(lockReceipt.status).toBe('success');

      const lockId = (await publicClient.readContract({
        address: htlcAddress,
        abi: ferryArtifact.abi,
        functionName: 'lockId',
        args: [userAccount.address, hashLock],
      })) as Hex;

      const solverBalBefore = (await publicClient.readContract({
        address: noReturnTokenAddress,
        abi: mockNoReturnArtifact.abi,
        functionName: 'balanceOf',
        args: [solverAccount.address],
      })) as bigint;

      // Solver claims tokens - SafeERC20 handles void transfer without reverting!
      const claimHash = await solverClient.writeContract({
        address: htlcAddress,
        abi: ferryArtifact.abi,
        functionName: 'claim',
        args: [lockId, `0x${secret.toString('hex')}`],
      });
      const claimReceipt = await publicClient.waitForTransactionReceipt({
        hash: claimHash,
      });
      expect(claimReceipt.status).toBe('success');

      const solverBalAfter = (await publicClient.readContract({
        address: noReturnTokenAddress,
        abi: mockNoReturnArtifact.abi,
        functionName: 'balanceOf',
        args: [solverAccount.address],
      })) as bigint;
      expect(solverBalAfter).toBe(solverBalBefore + amount);
    });

    it('safely locks and refunds token with void-return transfer/transferFrom (MockNoReturnTRC20)', async () => {
      const secret = randomBytes(32);
      const hashLock = sha256(secret);
      const currentBlock = await publicClient.getBlock();
      const deadline = currentBlock.timestamp + 5n;
      const amount = 800_000n;

      await userClient.writeContract({
        address: noReturnTokenAddress,
        abi: mockNoReturnArtifact.abi,
        functionName: 'approve',
        args: [htlcAddress, amount],
      });

      const lockHash = await userClient.writeContract({
        address: htlcAddress,
        abi: ferryArtifact.abi,
        functionName: 'lock',
        args: [
          noReturnTokenAddress,
          solverAccount.address,
          amount,
          hashLock,
          deadline,
        ],
      });
      await publicClient.waitForTransactionReceipt({ hash: lockHash });

      const lockId = (await publicClient.readContract({
        address: htlcAddress,
        abi: ferryArtifact.abi,
        functionName: 'lockId',
        args: [userAccount.address, hashLock],
      })) as Hex;

      // Advance time past deadline
      await publicClient.request({
        method: 'evm_increaseTime' as never,
        params: [10] as never,
      });
      await publicClient.request({
        method: 'evm_mine' as never,
        params: [] as never,
      });

      const userBalBefore = (await publicClient.readContract({
        address: noReturnTokenAddress,
        abi: mockNoReturnArtifact.abi,
        functionName: 'balanceOf',
        args: [userAccount.address],
      })) as bigint;

      // Refund succeeds with void-return token!
      const refundHash = await userClient.writeContract({
        address: htlcAddress,
        abi: ferryArtifact.abi,
        functionName: 'refund',
        args: [lockId],
      });
      const refundReceipt = await publicClient.waitForTransactionReceipt({
        hash: refundHash,
      });
      expect(refundReceipt.status).toBe('success');

      const userBalAfter = (await publicClient.readContract({
        address: noReturnTokenAddress,
        abi: mockNoReturnArtifact.abi,
        functionName: 'balanceOf',
        args: [userAccount.address],
      })) as bigint;
      expect(userBalAfter).toBe(userBalBefore + amount);
    });
  });

  describe('Validation & Edge Cases', () => {
    it('rejects lock with BadParams when recipient equals owner or amount is 0', async () => {
      const hashLock = `0x${'aa'.repeat(32)}` as Hex;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

      // Recipient == owner
      await expect(
        userClient.writeContract({
          address: htlcAddress,
          abi: ferryArtifact.abi,
          functionName: 'lock',
          args: [
            standardTokenAddress,
            userAccount.address,
            100_000n,
            hashLock,
            deadline,
          ],
        }),
      ).rejects.toThrow();

      // Amount == 0
      await expect(
        userClient.writeContract({
          address: htlcAddress,
          abi: ferryArtifact.abi,
          functionName: 'lock',
          args: [
            standardTokenAddress,
            solverAccount.address,
            0n,
            hashLock,
            deadline,
          ],
        }),
      ).rejects.toThrow();
    });
  });
});
