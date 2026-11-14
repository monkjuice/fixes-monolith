import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

import { fromBase64, utf8Decode, utf8Encode } from '../encoding';
import { CryptoError } from '../errors';
import { uuidv4 } from '../random';
import { generateTransferKey, openTransfer, sealTransfer, type TransferHeader } from '../transfer';

describe('transfer sealed box (§7.3)', () => {
  const header: TransferHeader = { kind: 'history', transferId: uuidv4(), attemptId: uuidv4(), seq: 1, total: 3 };
  const inner = { conversations: [], messages: [{ id: uuidv4(), body: 'hi' }], contact_identities: [] };

  it('round-trips and produces the documented payload fields', () => {
    const key = generateTransferKey();
    const payload = sealTransfer(header, inner, key);
    expect(payload).toMatchObject({
      v: 1,
      kind: 'history',
      transfer_id: header.transferId,
      attempt_id: header.attemptId,
      seq: 1,
      total: 3,
    });
    expect(fromBase64(payload.nonce)).toHaveLength(24);
    expect(openTransfer(JSON.parse(JSON.stringify(payload)), key).inner).toEqual(inner);
  });

  it('uses the exact AAD string', () => {
    const key = generateTransferKey();
    const payload = sealTransfer(header, inner, key);
    const aad = utf8Encode(`fixes/v1/history|${header.transferId}|${header.attemptId}|1|3`);
    const plain = xchacha20poly1305(key, fromBase64(payload.nonce), aad).decrypt(fromBase64(payload.sealed));
    expect(JSON.parse(utf8Decode(plain))).toEqual(inner);
  });

  it('fails with the wrong transfer key', () => {
    const payload = sealTransfer(header, inner, generateTransferKey());
    expect(() => openTransfer(payload, generateTransferKey())).toThrow(CryptoError);
  });

  it.each([
    ['seq', { seq: 2 }],
    ['total', { total: 4 }],
    ['attempt_id', { attempt_id: uuidv4() }],
    ['transfer_id', { transfer_id: uuidv4() }],
    ['kind', { kind: 'link' }],
  ])('fails when %s is changed (bound by the AAD)', (_field, change) => {
    const key = generateTransferKey();
    const payload = sealTransfer(header, inner, key);
    expect(() => openTransfer({ ...payload, ...change }, key)).toThrow(CryptoError);
  });

  it('validates the outer fields', () => {
    const key = generateTransferKey();
    const payload = sealTransfer(header, inner, key);
    expect(() => openTransfer({ ...payload, v: 2 }, key)).toThrow(/version/);
    expect(() => openTransfer({ ...payload, seq: 3 }, key)).toThrow(/sequence/);
    expect(() => openTransfer({ ...payload, transfer_id: 'nope' }, key)).toThrow(/UUIDv4/);
    expect(() => openTransfer(null, key)).toThrow(CryptoError);
  });

  it('enforces the 48 000-byte chunk limit and the key length', () => {
    const key = generateTransferKey();
    expect(() => sealTransfer(header, { blob: 'x'.repeat(48_000) }, key)).toThrow(/48 000/);
    expect(() => sealTransfer(header, inner, new Uint8Array(16))).toThrow(CryptoError);
  });
});
