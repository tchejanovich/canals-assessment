import { ConflictException, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { DatabaseTransaction } from '../db/database.module.js';
import { type Address, addresses } from '../db/schema/index.js';
import { buildAddressFingerprint } from './address-fingerprint.js';
import type { StoreAddressInput } from './addresses.types.js';

@Injectable()
export class AddressesService {
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
  ): Promise<Address> {
    const fingerprint = buildAddressFingerprint(input.address);

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
      throw new ConflictException(
        'Address could not be stored despite a stable fingerprint',
      );
    }

    return address;
  }
}
