import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, or } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  type DatabaseTransaction,
} from '../db/database.module.js';
import type { Coordinates } from '../common/geo.js';
import {
  type Address,
  addresses,
  countries,
  regions,
} from '../db/schema/index.js';
import { GeocodingService } from '../geocoding/geocoding.service.js';
import { buildAddressFingerprint } from './address-fingerprint.js';
import {
  AddressConflictError,
  UnknownCountryError,
  UnknownRegionError,
} from './addresses.errors.js';
import type { StoreAddressInput } from './addresses.types.js';

type AddressWithCoordinates = Address & {
  latitude: NonNullable<Address['latitude']>;
  longitude: NonNullable<Address['longitude']>;
};

@Injectable()
export class AddressesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly geocoding: GeocodingService,
  ) {}

  /** Resolve an address to the same precision used by persisted coordinates. */
  async resolveCoordinates(
    address: StoreAddressInput['address'],
  ): Promise<Coordinates> {
    const existingAddress = await this.findExisting(address);
    const resolved = existingAddress
      ? {
          latitude: Number(existingAddress.latitude),
          longitude: Number(existingAddress.longitude),
        }
      : await this.geocoding.getCoordinates(address);

    return {
      latitude: Number(resolved.latitude.toFixed(6)),
      longitude: Number(resolved.longitude.toFixed(6)),
    };
  }

  /** Look up a cached address without creating a row before stock is checked. */
  async findExisting(
    address: StoreAddressInput['address'],
  ): Promise<AddressWithCoordinates | null> {
    const fingerprint = buildAddressFingerprint(address);
    const [existing] = await this.db
      .select()
      .from(addresses)
      .where(eq(addresses.fingerprint, fingerprint))
      .limit(1);

    return existing && existing.latitude !== null && existing.longitude !== null
      ? this.requireCoordinates(existing)
      : null;
  }

  /**
   * Idempotently persists the address and returns it. The `addresses` table is
   * deduplicated by fingerprint, so this inserts on first sight and otherwise
   * returns the existing row. The `onConflictDoNothing` + re-select handles the
   * concurrent case where another transaction inserted the same fingerprint
   * between our two statements (the insert blocks on the loser's row lock, then
   * yields nothing, and the re-select reads the committed row).
   *
   * Runs inside the caller's transaction so the address is committed atomically
   * with whatever references it (e.g. the order header).
   */
  async findOrCreate(
    tx: DatabaseTransaction,
    input: StoreAddressInput,
  ): Promise<AddressWithCoordinates> {
    const fingerprint = buildAddressFingerprint(input.address);
    const [existing] = await tx
      .select()
      .from(addresses)
      .where(eq(addresses.fingerprint, fingerprint))
      .limit(1);
    if (existing) {
      return this.ensureCoordinates(tx, existing, input);
    }

    const inserted = await tx
      .insert(addresses)
      .values({
        customerId: input.customerId,
        line1: input.address.line1,
        line2: input.address.line2 ?? null,
        city: input.address.city,
        regionId: input.regionId,
        postalCode: input.address.postalCode,
        countryId: input.countryId,
        latitude: input.coordinates.latitude.toFixed(6),
        longitude: input.coordinates.longitude.toFixed(6),
        fingerprint,
      })
      .onConflictDoNothing({ target: addresses.fingerprint })
      .returning();

    const address =
      inserted[0] ??
      (
        await tx
          .select()
          .from(addresses)
          .where(eq(addresses.fingerprint, fingerprint))
          .limit(1)
      )[0];

    if (!address) {
      throw new AddressConflictError();
    }

    return this.ensureCoordinates(tx, address, input);
  }

  private async ensureCoordinates(
    tx: DatabaseTransaction,
    address: Address,
    input: StoreAddressInput,
  ): Promise<AddressWithCoordinates> {
    if (address.latitude !== null && address.longitude !== null) {
      return this.requireCoordinates(address);
    }

    const [updated] = await tx
      .update(addresses)
      .set({
        latitude: input.coordinates.latitude.toFixed(6),
        longitude: input.coordinates.longitude.toFixed(6),
      })
      .where(
        and(
          eq(addresses.id, address.id),
          or(isNull(addresses.latitude), isNull(addresses.longitude)),
        ),
      )
      .returning();

    if (updated) return this.requireCoordinates(updated);

    const [current] = await tx
      .select()
      .from(addresses)
      .where(eq(addresses.id, address.id))
      .limit(1);
    if (current && current.latitude !== null && current.longitude !== null) {
      return this.requireCoordinates(current);
    }

    throw new AddressConflictError();
  }

  private requireCoordinates(address: Address): AddressWithCoordinates {
    if (address.latitude === null || address.longitude === null) {
      throw new AddressConflictError();
    }
    return address as AddressWithCoordinates;
  }

  /**
   * Resolves an ISO country code to its stored id, rejecting unknown codes.
   */
  async resolveCountry(countryCode: string): Promise<number> {
    const [country] = await this.db
      .select({ id: countries.id })
      .from(countries)
      .where(eq(countries.code, countryCode))
      .limit(1);
    if (!country) {
      throw new UnknownCountryError(countryCode);
    }
    return country.id;
  }

  /**
   * Resolves a region code scoped to a country to its stored id, rejecting
   * unknown codes.
   */
  async resolveRegion(countryId: number, regionCode: string): Promise<number> {
    const [region] = await this.db
      .select({ id: regions.id })
      .from(regions)
      .where(
        and(eq(regions.countryId, countryId), eq(regions.code, regionCode)),
      )
      .limit(1);
    if (!region) {
      throw new UnknownRegionError(regionCode);
    }
    return region.id;
  }
}
