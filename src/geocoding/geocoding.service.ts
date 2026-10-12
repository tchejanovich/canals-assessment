import { Injectable } from '@nestjs/common';
import { normalizeAddressParts } from '../addresses/address-fingerprint.js';
import { fnv1aHash } from '../common/hash.js';
import type { Coordinates } from '../common/geo.js';
import type { GeocodingAddress } from './geocoding.types.js';

@Injectable()
export class GeocodingService {
  async getCoordinates(address: GeocodingAddress): Promise<Coordinates> {
    const normalized = normalizeAddressParts(address);

    return {
      latitude:
        (fnv1aHash(JSON.stringify(['latitude', normalized])) % 1801) / 10 - 90,
      longitude:
        (fnv1aHash(JSON.stringify(['longitude', normalized])) % 3601) / 10 -
        180,
    };
  }
}
