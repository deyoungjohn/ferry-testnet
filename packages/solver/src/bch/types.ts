export interface ElectrumUtxo {
  height: number;
  tx_hash: string;
  tx_pos: number;
  value: number;
  token_data?: {
    category: string;
    amount: string;
    nft?: {
      capability: string;
      commitment: string;
    };
  };
}

export interface ElectrumHistoryEntry {
  height: number;
  tx_hash: string;
  fee?: number;
}

export interface TipStatus {
  height: number;
  timestamp: number;
}

export interface BchQuorumStatus {
  quorumTip: number;
  tips: { [serverUrl: string]: number };
  isQuorumHealthy: boolean;
  ageSeconds: number;
}

export interface DSProofEvidence {
  txid: string;
  hasProof: boolean;
  proofData?: unknown;
}

export interface DSProofWatcher {
  subscribe(txid: string, callback: (evidence: DSProofEvidence) => void): void;
  unsubscribe(txid: string): void;
}
