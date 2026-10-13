import { Inject, Injectable, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(AddressesService.name);

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

  /** Inserts on first use or returns the fingerprint match. Re-selects after a
   * concurrent insert; the caller's transaction keeps address and order atomic.
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
      this.logger.debug(`Reusing shipping address ${existing.id}`);
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

    this.logger.log(
      inserted[0]
        ? `Inserted shipping address ${address.id} in the order transaction`
        : `Reusing shipping address ${address.id} inserted concurrently`,
    );
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

  /** Finds a country by ISO code, or throws if it is unknown. */
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

  /** Finds a region by country and code, or throws if it is unknown. */
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
