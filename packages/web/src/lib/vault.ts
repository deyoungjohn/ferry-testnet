import type { Hex32 } from '@ferry/core';

const DB_NAME = 'ferry-vault';
const DB_VERSION = 1;
const KEY_STORE = 'keys';
const SECRET_STORE = 'secrets';
const KEY_ID = 'aes-gcm';

interface SecretRecord {
  orderId: string;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}

function request<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) {
        db.createObjectStore(KEY_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SECRET_STORE)) {
        db.createObjectStore(SECRET_STORE, { keyPath: 'orderId' });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () =>
      reject(open.error ?? new Error('Could not open the Ferry vault'));
  });
}

async function getOrCreateKey(db: IDBDatabase): Promise<CryptoKey> {
  const read = db.transaction(KEY_STORE, 'readonly');
  const existing = await request<{ id: string; key: CryptoKey } | undefined>(
    read.objectStore(KEY_STORE).get(KEY_ID),
  );
  if (existing) return existing.key;

  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const write = db.transaction(KEY_STORE, 'readwrite');
  write.objectStore(KEY_STORE).put({ id: KEY_ID, key });
  await transactionDone(write);
  return key;
}

function hexToBytes(value: Hex32): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(
      value.slice(2 + index * 2, 4 + index * 2),
      16,
    );
  }
  return bytes;
}

function bytesToHex(value: Uint8Array): Hex32 {
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function saveSecret(orderId: Hex32, secret: Hex32): Promise<void> {
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(orderId) ||
    !/^0x[0-9a-fA-F]{64}$/.test(secret)
  ) {
    throw new TypeError('Vault values must be 32 bytes');
  }

  const db = await openDatabase();
  try {
    const key = await getOrCreateKey(db);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      hexToBytes(secret),
    );
    const write = db.transaction(SECRET_STORE, 'readwrite');
    write.objectStore(SECRET_STORE).put({
      orderId,
      iv,
      ciphertext,
    } satisfies SecretRecord);
    await transactionDone(write);
  } finally {
    db.close();
  }
}

export async function loadSecret(orderId: Hex32): Promise<Hex32 | null> {
  const db = await openDatabase();
  try {
    const read = db.transaction(SECRET_STORE, 'readonly');
    const record = await request<SecretRecord | undefined>(
      read.objectStore(SECRET_STORE).get(orderId),
    );
    if (!record) return null;

    const keyRead = db.transaction(KEY_STORE, 'readonly');
    const keyRecord = await request<{ id: string; key: CryptoKey } | undefined>(
      keyRead.objectStore(KEY_STORE).get(KEY_ID),
    );
    if (!keyRecord) throw new Error('Vault key is missing');

    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: record.iv },
        keyRecord.key,
        record.ciphertext,
      );
      return bytesToHex(new Uint8Array(plaintext));
    } catch {
      throw new Error('Vault decrypt failed: the record was tampered with');
    }
  } finally {
    db.close();
  }
}

export async function deleteSecret(orderId: Hex32): Promise<void> {
  const db = await openDatabase();
  try {
    const write = db.transaction(SECRET_STORE, 'readwrite');
    write.objectStore(SECRET_STORE).delete(orderId);
    await transactionDone(write);
  } finally {
    db.close();
  }
}

export async function listVaultOrderIds(): Promise<string[]> {
  const db = await openDatabase();
  try {
    const read = db.transaction(SECRET_STORE, 'readonly');
    const keys = await request<IDBValidKey[]>(
      read.objectStore(SECRET_STORE).getAllKeys(),
    );
    return keys.map(String);
  } finally {
    db.close();
  }
}

export async function deleteVaultDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const requestDelete = indexedDB.deleteDatabase(DB_NAME);
    requestDelete.onsuccess = () => resolve();
    requestDelete.onerror = () =>
      reject(requestDelete.error ?? new Error('Could not delete the vault'));
    requestDelete.onblocked = () => resolve();
  });
}
