import type { XOTemplate } from '@xo-cash/types';

export const ferryHtlcTemplate: XOTemplate = {
  $schema: 'https://libauth.org/schemas/wallet-template-v0.schema.json',
  name: 'Ferry HTLC',
  description:
    'Cross-chain Hash Time Locked Contract covenant for Bitcoin Cash CashTokens swaps.',
  version: '1',
  supported: ['BCH_2023_05', 'BCH_2024_05', 'BCH_2025_05', 'BCH_2026_05'],
  roles: {
    locker: {
      name: 'Locker',
      description:
        'The party funding the HTLC covenant with tokens and carry satoshis.',
    },
    claimer: {
      name: 'Claimer',
      description:
        'The recipient claiming tokens by revealing the preimage secret.',
    },
    refunder: {
      name: 'Refunder',
      description:
        'The party refunding tokens after the refund height has passed.',
    },
  },
  start: [],
  actions: {
    lock: {
      name: 'Lock',
      description:
        'Fund the Ferry HTLC covenant with tokens and carry satoshis.',
      roles: {
        locker: {
          requirements: {
            variables: [
              'hashLock',
              'recipientLockingBytecode',
              'refundLockingBytecode',
              'tokenCategory',
              'tokenAmount',
              'refundHeight',
              'maxFee',
              'bchCarrySats',
            ],
          },
        },
      },
      requirements: {
        participants: [
          {
            role: 'locker',
            slots: {
              min: 1,
              max: 1,
            },
          },
        ],
      },
      transaction: 'lockTransaction',
    },
    claim: {
      name: 'Claim',
      description:
        'Claim tokens from the Ferry HTLC covenant by providing the secret.',
      roles: {
        claimer: {
          requirements: {
            variables: ['secret'],
          },
        },
      },
      requirements: {
        participants: [
          {
            role: 'claimer',
            slots: {
              min: 1,
              max: 1,
            },
          },
        ],
      },
      transaction: 'claimTransaction',
    },
    refund: {
      name: 'Refund',
      description:
        'Refund tokens from the Ferry HTLC covenant after refundHeight is reached.',
      roles: {
        refunder: {
          requirements: {
            variables: ['refundHeight'],
          },
        },
      },
      requirements: {
        participants: [
          {
            role: 'refunder',
            slots: {
              min: 1,
              max: 1,
            },
          },
        ],
      },
      transaction: 'refundTransaction',
    },
  },
  transactions: {
    lockTransaction: {
      name: 'Lock Transaction',
      description: 'Fund the HTLC covenant output.',
      inputs: [],
      outputs: [
        {
          output: 'htlcOutput',
          outputIndex: 0,
        },
      ],
    },
    claimTransaction: {
      name: 'Claim Transaction',
      description: 'Spend HTLC covenant to recipient by providing the secret.',
      inputs: [
        {
          input: 'claimHtlcInput',
          inputIndex: 0,
        },
      ],
      outputs: [
        {
          output: 'claimRecipientOutput',
          outputIndex: 0,
        },
      ],
    },
    refundTransaction: {
      name: 'Refund Transaction',
      description:
        'Refund HTLC covenant to refunder after refund block height.',
      locktime: '$(<refundHeight>)',
      inputs: [
        {
          input: 'refundHtlcInput',
          inputIndex: 0,
        },
      ],
      outputs: [
        {
          output: 'refundOutput',
          outputIndex: 0,
        },
      ],
    },
  },
  inputs: {
    claimHtlcInput: {
      name: 'HTLC UTXO for Claim',
      description: 'The HTLC covenant UTXO being claimed.',
      valueSatoshis: '$(<bchCarrySats>)',
      token: {
        category: '$(<tokenCategory>)',
        amount: '$(<tokenAmount>)',
        nft: null,
      },
      unlockingScript: 'claimUnlockingBytecode',
    },
    refundHtlcInput: {
      name: 'HTLC UTXO for Refund',
      description: 'The HTLC covenant UTXO being refunded.',
      valueSatoshis: '$(<bchCarrySats>)',
      token: {
        category: '$(<tokenCategory>)',
        amount: '$(<tokenAmount>)',
        nft: null,
      },
      sequenceNumber: 4294967294, // 0xfffffffe (enables CLTV)
      unlockingScript: 'refundUnlockingBytecode',
    },
  },
  outputs: {
    htlcOutput: {
      name: 'HTLC Covenant Output',
      description: 'The covenant output holding the tokens.',
      lockingScript: 'htlcLockingScript',
      valueSatoshis: '$(<bchCarrySats>)',
      token: {
        category: '$(<tokenCategory>)',
        amount: '$(<tokenAmount>)',
        nft: null,
      },
    },
    claimRecipientOutput: {
      name: 'Recipient Token Output',
      description: 'Receives the claimed tokens.',
      lockingScript: '$(<recipientLockingBytecode>)',
      valueSatoshis: '$(<bchCarrySats> <maxFee> OP_SUB)',
      token: {
        category: '$(<tokenCategory>)',
        amount: '$(<tokenAmount>)',
        nft: null,
      },
    },
    refundOutput: {
      name: 'Refund Token Output',
      description: 'Receives the refunded tokens.',
      lockingScript: '$(<refundLockingBytecode>)',
      valueSatoshis: '$(<bchCarrySats> <maxFee> OP_SUB)',
      token: {
        category: '$(<tokenCategory>)',
        amount: '$(<tokenAmount>)',
        nft: null,
      },
    },
  },
  lockingScripts: {
    htlcLockingScript: {
      name: 'Ferry HTLC P2SH32',
      description: 'P2SH32 script for the HTLC covenant.',
      lockingType: 'p2sh',
      lockingBytecode: 'htlcLockingBytecode',
    },
  },
  scripts: {
    htlcCoreBytecode:
      'OP_7 OP_PICK OP_0 OP_NUMEQUAL OP_IF OP_8 OP_PICK OP_SIZE OP_NIP <32> OP_NUMEQUALVERIFY OP_8 OP_ROLL OP_SHA256 OP_EQUALVERIFY OP_INPUTINDEX OP_0 OP_NUMEQUALVERIFY OP_TXINPUTCOUNT OP_1 OP_NUMEQUALVERIFY OP_TXOUTPUTCOUNT OP_1 OP_NUMEQUALVERIFY OP_0 OP_OUTPUTBYTECODE OP_EQUALVERIFY OP_0 OP_OUTPUTTOKENCATEGORY OP_ROT OP_EQUALVERIFY OP_0 OP_OUTPUTTOKENAMOUNT OP_ROT OP_NUMEQUALVERIFY OP_0 OP_OUTPUTVALUE OP_0 OP_UTXOVALUE OP_4 OP_ROLL OP_SUB OP_GREATERTHANOREQUAL OP_NIP OP_NIP OP_NIP OP_ELSE OP_7 OP_ROLL OP_1 OP_NUMEQUALVERIFY OP_5 OP_ROLL OP_CHECKLOCKTIMEVERIFY OP_DROP OP_INPUTINDEX OP_0 OP_NUMEQUALVERIFY OP_TXINPUTCOUNT OP_1 OP_NUMEQUALVERIFY OP_TXOUTPUTCOUNT OP_1 OP_NUMEQUALVERIFY OP_0 OP_OUTPUTBYTECODE OP_3 OP_ROLL OP_EQUALVERIFY OP_0 OP_OUTPUTTOKENCATEGORY OP_3 OP_ROLL OP_EQUALVERIFY OP_0 OP_OUTPUTTOKENAMOUNT OP_3 OP_ROLL OP_NUMEQUALVERIFY OP_0 OP_OUTPUTVALUE OP_0 OP_UTXOVALUE OP_4 OP_ROLL OP_SUB OP_GREATERTHANOREQUAL OP_NIP OP_NIP OP_ENDIF',
    htlcLockingBytecode:
      '<maxFee> <refundHeight> <tokenAmount> <tokenCategory> <refundLockingBytecode> <recipientLockingBytecode> <hashLock> htlcCoreBytecode',
    claimUnlockingBytecode: '<secret> <0> <htlcLockingBytecode>',
    refundUnlockingBytecode: '<1> <htlcLockingBytecode>',
  },
  constants: {},
  variables: {
    hashLock: {
      name: 'Hash Lock',
      description: '32-byte SHA-256 hash of secret preimage.',
      type: 'bytes',
    },
    recipientLockingBytecode: {
      name: 'Recipient Locking Bytecode',
      description: 'Locking bytecode of the claim recipient.',
      type: 'locking_script',
    },
    refundLockingBytecode: {
      name: 'Refund Locking Bytecode',
      description: 'Locking bytecode of the refund payee.',
      type: 'locking_script',
    },
    tokenCategory: {
      name: 'Token Category',
      description: '32-byte token category in internal byte order.',
      type: 'bytes',
    },
    tokenAmount: {
      name: 'Token Amount',
      description: 'Fungible token amount in base units.',
      type: 'integer',
    },
    refundHeight: {
      name: 'Refund Block Height',
      description: 'Absolute block height for CLTV refund.',
      type: 'integer',
    },
    maxFee: {
      name: 'Max Miner Fee',
      description: 'Maximum satoshis that can be deducted for miner fee.',
      type: 'integer',
    },
    bchCarrySats: {
      name: 'Carry Satoshis',
      description:
        'Satoshis carried by the HTLC UTXO to pay claim/refund fees.',
      type: 'satoshis',
    },
    secret: {
      name: 'Preimage Secret',
      description: '32-byte secret preimage revealed on claim.',
      type: 'bytes',
    },
  },
};
