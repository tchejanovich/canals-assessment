import { Injectable } from '@nestjs/common';
import { normalizeAddressParts } from '../addresses/address-fingerprint.js';
import type { Coordinates } from '../common/geo.js';
import type { GeocodingAddress } from './geocoding.types.js';

/**
 * Makes a repeatable 32-bit number from a string for the mock geocoder. It uses
 * the FNV-1a recipe: start at 2166136261, XOR each character, then multiply by
 * 16777619. The final conversion keeps the result unsigned; this isn't for security.
 */
function fnv1aHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

@Injectable()
export class GeocodingService {
  /**
   * This mock doesn't look up a real location. It normalizes the address and
   * makes a separate stable hash for each axis, so the same address always gets
   * the same coordinates. `% 1801` then `/10 - 90` maps latitude to -90…90;
   * `% 3601` then `/10 - 180` maps longitude to -180…180, both in 0.1° steps.
   */
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
