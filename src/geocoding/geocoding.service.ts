import { Injectable } from '@nestjs/common';
import { fnv1aHash } from '../common/hash.js';
import type { Coordinates } from '../common/geo.js';
import type { GeocodingAddress } from './geocoding.types.js';

@Injectable()
export class GeocodingService {
  async getCoordinates(address: GeocodingAddress): Promise<Coordinates> {
    const normalized = [
      address.line1,
      address.line2 ?? '',
      address.city,
      address.region,
      address.postalCode,
      address.country,
    ]
      .map((part) => part.trim().toLowerCase())
      .join('|');

    return {
      latitude: ((fnv1aHash(normalized) % 1801) / 10) - 90,
      longitude: ((fnv1aHash(`${normalized}|lon`) % 3601) / 10) - 180,
    };
  }
}
