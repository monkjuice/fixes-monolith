import { generateDeviceKeyPair } from '../../crypto/deviceKeys';
import { toBase64Url } from '../../crypto/encoding';
import { uuidv4 } from '../../crypto/random';
import { formatLinkQr, LinkQrError, parseLinkQr } from '../qr';

describe('link QR code (§9 step 2)', () => {
  const qr = {
    transferId: uuidv4(),
    deviceId: uuidv4(),
    devicePublicKey: generateDeviceKeyPair().publicKey,
    // 0xfb bytes encode as "-_v7…" in base64url, so the alphabet cases below always apply.
    transferKey: new Uint8Array(32).fill(0xfb),
  };
  const text = formatLinkQr(qr);
  const withPart = (index: number, value: string) => {
    const parts = text.split(':');
    parts[index] = value;
    return parts.join(':');
  };

  it('formats and parses fixes-link:1:<transfer>:<device>:<pk b64url>:<key b64url>', () => {
    expect(text).toBe(
      `fixes-link:1:${qr.transferId}:${qr.deviceId}:${toBase64Url(qr.devicePublicKey)}:${toBase64Url(qr.transferKey)}`,
    );
    expect(toBase64Url(qr.transferKey)).toMatch(/^-_/);
    expect(text.split(':')[5]).not.toMatch(/[=+/]/);
    expect(parseLinkQr(`  ${text}\n`)).toEqual(qr);
  });

  it.each([
    ['another scheme', () => withPart(0, 'otpauth')],
    ['another version', () => withPart(1, '2')],
    ['a missing part', () => text.split(':').slice(0, 5).join(':')],
    ['an extra part', () => `${text}:extra`],
    ['an uppercase id', () => withPart(2, qr.transferId.toUpperCase())],
    ['a short key', () => withPart(5, text.split(':')[5].slice(0, -4))],
    ['padding', () => withPart(5, `${text.split(':')[5]}=`)],
    ['standard base64 characters', () => withPart(5, text.split(':')[5].replace('-', '+').replace('_', '/'))],
    ['a non-canonical last character', () => withPart(5, `${text.split(':')[5].slice(0, -1)}9`)],
    ['empty', () => ''],
  ])('refuses %s', (_name, mutate) => {
    const mutated = mutate();
    expect(mutated).not.toBe(text);
    expect(() => parseLinkQr(mutated)).toThrow(LinkQrError);
  });
});
