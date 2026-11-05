import type { Hex32 } from '@ferry/core';
import { solverIsLive } from '../solver/kind';
import type { OrderView, SignedQuote } from '../solver/types';

const DB_NAME = 'ferry-orders';
const DB_VERSION = 1;
const STORE = 'orders';

export interface PersistedOrder extends OrderView {
  readonly createdAt: number;
  readonly solverLive: boolean;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'orderId' });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () =>
      reject(open.error ?? new Error('Could not open the order journal'));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error('Order journal request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Order journal write failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Order journal write aborted'));
  });
}

export async function saveOrderRecord(
  view: OrderView,
  solverLive = solverIsLive(),
): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(view.orderId)) {
    throw new TypeError('Order id must be 32 bytes');
  }
  const db = await openDatabase();
  try {
    const read = db.transaction(STORE, 'readonly');
    const existing = await request<PersistedOrder | undefined>(
      read.objectStore(STORE).get(view.orderId),
    );
    const record: PersistedOrder = {
      ...view,
      createdAt: existing?.createdAt ?? Math.floor(Date.now() / 1_000),
      solverLive,
    };
    const write = db.transaction(STORE, 'readwrite');
    write.objectStore(STORE).put(record);
    await transactionDone(write);
  } finally {
    db.close();
  }
}

export async function saveQuoteRecord(
  quote: SignedQuote,
  solverLive = solverIsLive(),
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await saveOrderRecord(
    {
      orderId: quote.orderId,
      status: 'QUOTED',
      terms: quote.terms,
      lane: quote.lane,
      bchTipHeight: quote.bchTipHeight,
      bchTipError: null,
      updatedAt: now,
      transactions: [],
      bchLockUtxo: null,
      claimAvailable: false,
      refundAvailable: false,
      bchRefundAvailable: false,
    },
    solverLive,
  );
}

export async function loadOrderRecord(
  orderId: Hex32,
): Promise<PersistedOrder | null> {
  const db = await openDatabase();
  try {
    const read = db.transaction(STORE, 'readonly');
    const record = await request<PersistedOrder | undefined>(
      read.objectStore(STORE).get(orderId),
    );
    return record ?? null;
  } finally {
    db.close();
  }
}

/** Every order saved in this browser, newest first (My Activity). */
export async function listOrderRecords(): Promise<PersistedOrder[]> {
  const db = await openDatabase();
  try {
    const read = db.transaction(STORE, 'readonly');
    const records = await request<PersistedOrder[]>(
      read.objectStore(STORE).getAll(),
    );
    return records
      .filter((record) => record.status !== 'QUOTED')
      .sort((a, b) => b.createdAt - a.createdAt);
  } finally {
    db.close();
  }
}

export async function deleteOrderDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const deletion = indexedDB.deleteDatabase(DB_NAME);
    deletion.onsuccess = () => resolve();
    deletion.onerror = () =>
      reject(deletion.error ?? new Error('Could not delete order journal'));
    deletion.onblocked = () => resolve();
  });
}
