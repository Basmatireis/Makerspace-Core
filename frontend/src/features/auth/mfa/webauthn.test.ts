import { describe, expect, it } from 'vitest';
import { base64UrlToBuffer, bufferToBase64Url, decodeCreationOptions, decodeRequestOptions } from './webauthn';

describe('base64url helpers', () => {
  it('round-trips bytes without padding and with the URL-safe alphabet', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe, 0x00, 0x01]);
    const encoded = bufferToBase64Url(bytes);
    expect(encoded).toBe('-__-AAE');
    expect(encoded).not.toMatch(/[+/=]/);
    expect([...new Uint8Array(base64UrlToBuffer(encoded))]).toEqual([...bytes]);
  });

  it('handles every length remainder and empty input', () => {
    for (const length of [0, 1, 2, 3, 4, 31, 32]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) % 256);
      expect([...new Uint8Array(base64UrlToBuffer(bufferToBase64Url(bytes)))]).toEqual([...bytes]);
    }
  });

  it('encodes views at their own offset', () => {
    const backing = new Uint8Array([9, 1, 2, 3, 9]);
    expect(bufferToBase64Url(backing.subarray(1, 4))).toBe(bufferToBase64Url(new Uint8Array([1, 2, 3])));
  });
});

describe('ceremony options', () => {
  it('decodes challenge, user handle and credential ids for creation', () => {
    const options = decodeCreationOptions({
      publicKey: {
        challenge: 'AQID',
        rp: { id: 'example.test', name: 'Makerspace' },
        user: { id: 'BAUG', name: 'ada', displayName: 'Ada' },
        excludeCredentials: [{ type: 'public-key', id: 'BwgJ' }],
      },
    });
    expect([...new Uint8Array(options.challenge as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(options.user.id as ArrayBuffer)]).toEqual([4, 5, 6]);
    expect([...new Uint8Array(options.excludeCredentials![0].id as ArrayBuffer)]).toEqual([7, 8, 9]);
    expect(options.rp.id).toBe('example.test');
  });

  it('decodes the challenge and allowed credentials for assertions, and tolerates none', () => {
    const options = decodeRequestOptions({
      publicKey: {
        challenge: 'AQID',
        allowCredentials: [{ type: 'public-key', id: 'BwgJ' }],
        userVerification: 'required',
      },
    });
    expect([...new Uint8Array(options.allowCredentials![0].id as ArrayBuffer)]).toEqual([7, 8, 9]);
    expect(options.userVerification).toBe('required');
    expect(decodeRequestOptions({ publicKey: { challenge: 'AQID' } }).allowCredentials).toBeUndefined();
  });
});
