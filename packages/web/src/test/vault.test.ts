import type { Hex32 } from '@ferry/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteVaultDatabase,
  listVaultOrderIds,
  loadSecret,
  saveSecret,
} from '../lib/vault';

const ORDER_ID = `0x${'a'.repeat(64)}` as Hex32;
const SECRET = `0x${'b'.repeat(64)}` as Hex32;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ferry-vault');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function request<T>(input: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    input.onsuccess = () => resolve(input.result);
    input.onerror = () => reject(input.error);
  });
}

beforeEach(async () => {
  await deleteVaultDatabase();
});

describe('secret vault', () => {
  it('round-trips the secret through AES-GCM and IndexedDB', async () => {
    await saveSecret(ORDER_ID, SECRET);
    await expect(loadSecret(ORDER_ID)).resolves.toBe(SECRET);
  });

  it('rejects a tampered ciphertext instead of returning a bad secret', async () => {
    await saveSecret(ORDER_ID, SECRET);
    const db = await openDb();
    const tx = db.transaction('secrets', 'readwrite');
    const store = tx.objectStore('secrets');
    const record = await request<{
      orderId: string;
      iv: Uint8Array;
      ciphertext: ArrayBuffer;
    }>(store.get(ORDER_ID));
    const bytes = new Uint8Array(record.ciphertext);
    bytes[0] = bytes[0]! ^ 0xff;
    record.ciphertext = bytes.buffer;
    await request(store.put(record));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    const error = await loadSecret(ORDER_ID).catch((cause: unknown) => cause);
    expect(String(error)).toContain('tampered');
  });

  it('stores only the order id as a key and never the secret in plaintext', async () => {
    await saveSecret(ORDER_ID, SECRET);

    const keys = await listVaultOrderIds();
    expect(keys).toEqual([ORDER_ID]);
    expect(keys.join(' ')).not.toContain(SECRET);
    expect(Object.keys(localStorage)).not.toContain(SECRET);

    const db = await openDb();
    const tx = db.transaction('secrets', 'readonly');
    const records = await request<unknown[]>(
      tx.objectStore('secrets').getAll(),
    );
    db.close();
    expect(JSON.stringify(records)).not.toContain(SECRET);
  });
});
