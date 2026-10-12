import {
  buildAddressFingerprint,
  normalizeAddressParts,
} from './address-fingerprint.js';

describe('address fingerprint canonicalization', () => {
  it('trims and lowercases fields without collapsing internal whitespace', () => {
    const address = {
      line1: '  10 Main  St ',
      line2: null,
      city: ' NEW YORK ',
      region: 'NY',
      postalCode: ' 10001 ',
      country: 'US',
    };

    expect(normalizeAddressParts(address)).toEqual([
      '10 main  st',
      '',
      'new york',
      'ny',
      '10001',
      'us',
    ]);
  });

  it('keeps field boundaries distinct when values contain separators', () => {
    const first = {
      line1: 'a',
      line2: 'b|c',
      city: 'd',
      region: 'NY',
      postalCode: '12345',
      country: 'US',
    };
    const second = {
      line1: 'a',
      line2: 'b',
      city: 'c|d',
      region: 'NY',
      postalCode: '12345',
      country: 'US',
    };

    expect(buildAddressFingerprint(first)).not.toBe(
      buildAddressFingerprint(second),
    );
  });
});
