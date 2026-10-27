import { DappConnectionManager } from '@wizardconnect/dapp';
import {
  RelayMsgAction,
  RelayStatus,
  parseExtendedJson,
  toUint8Array,
  type ProtocolMessage,
  type RelayClient,
} from '@wizardconnect/core';
import { describe, expect, it } from 'vitest';
import { sourceOutputToRelay } from '../lib/wallet/relay-format';

class FakeRelay {
  readonly sent: ProtocolMessage[] = [];
  readonly #listeners = new Map<string, (message: unknown) => void>();

  isKeyExchangeComplete(): boolean {
    return true;
  }

  nextSequence(): number {
    return 42;
  }

  on(event: string, listener: (message: unknown) => void): this {
    this.#listeners.set(event, listener);
    return this;
  }

  emit(event: string, message: unknown): void {
    this.#listeners.get(event)?.(message);
  }

  async relay(message: ProtocolMessage): Promise<void> {
    this.sent.push(message);
    if (message.action === RelayMsgAction.SignTransactionRequest) {
      const request = message as unknown as { readonly sequence: number };
      queueMicrotask(() => {
        this.emit('message', {
          action: RelayMsgAction.SignTransactionResponse,
          time: Math.floor(Date.now() / 1_000),
          sequence: request.sequence,
          signedTransaction: '00',
        });
      });
    }
  }
}

describe('real DappConnectionManager relay serialization', () => {
  it('produces JSON a wallet can parse with parseExtendedJson', async () => {
    const manager = new DappConnectionManager('Ferry', undefined, {
      session: false,
    });
    const relay = new FakeRelay();
    manager.updateConnection(
      relay as unknown as RelayClient,
      RelayStatus.connected('test-session'),
    );

    const sourceOutput = {
      outpointIndex: 1,
      outpointTransactionHash: Uint8Array.from([0xab, 0x01]),
      sequenceNumber: 0xffffffff,
      unlockingBytecode: new Uint8Array(),
      valueSatoshis: 5_000n,
      lockingBytecode: Uint8Array.from([0x76, 0xa9]),
      token: { category: Uint8Array.from([0xec, 0x33]), amount: 2_500n },
    };

    const response = await manager.signTransaction({
      transaction: {
        transaction: '00',
        sourceOutputs: [
          sourceOutputToRelay(sourceOutput),
        ] as unknown as never[],
        broadcast: false,
        userPrompt: 'Lock funds',
      },
      inputPaths: [[0, 'receive', 0]],
    });
    expect(response.signedTransaction).toBe('00');

    const request = relay.sent.find(
      (message) => message.action === RelayMsgAction.SignTransactionRequest,
    );
    expect(request).toBeDefined();
    const json = JSON.stringify(request);
    expect(json).not.toContain('[object Object]');

    const walletView = parseExtendedJson(json) as {
      action: string;
      inputPaths: [[number, string, number]];
      transaction: {
        sourceOutputs: [
          {
            outpointTransactionHash: string;
            valueSatoshis: bigint;
            lockingBytecode: string;
            token: { category: string; amount: bigint };
          },
        ];
      };
    };
    expect(walletView.action).toBe(RelayMsgAction.SignTransactionRequest);
    expect(walletView.inputPaths).toEqual([[0, 'receive', 0]]);
    expect(walletView.transaction.sourceOutputs[0]?.valueSatoshis).toBe(5_000n);
    expect(walletView.transaction.sourceOutputs[0]?.token.amount).toBe(2_500n);
    expect(
      Array.from(
        toUint8Array(
          walletView.transaction.sourceOutputs[0]?.outpointTransactionHash ??
            '',
        ),
      ),
    ).toEqual([0xab, 0x01]);
    expect(
      Array.from(
        toUint8Array(
          walletView.transaction.sourceOutputs[0]?.lockingBytecode ?? '',
        ),
      ),
    ).toEqual([0x76, 0xa9]);
    manager.destroy();
  });
});
