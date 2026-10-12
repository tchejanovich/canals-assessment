import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  type DatabaseTransaction,
} from '../db/database.module.js';
import { type Customer, customers } from '../db/schema/index.js';
import {
  CustomerNameMismatchError,
  CustomerPhoneMismatchError,
} from './customers.errors.js';
import type { CustomerInput } from './customers.types.js';

@Injectable()
export class CustomersService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async validateForOrder(input: CustomerInput): Promise<void> {
    const [row] = await this.db
      .select()
      .from(customers)
      .where(eq(customers.email, normalizeEmail(input.email)))
      .limit(1);
    if (row) this.assertMatchingDetails(row, input);
  }

  async findOrCreate(
    tx: DatabaseTransaction,
    input: CustomerInput,
  ): Promise<Customer> {
    const email = normalizeEmail(input.email);
    const [existing] = await tx
      .select()
      .from(customers)
      .where(eq(customers.email, email))
      .limit(1);
    if (existing) {
      this.assertMatchingDetails(existing, input);
      return existing;
    }

    const [inserted] = await tx
      .insert(customers)
      .values({
        name: input.name,
        email,
        phone: input.phone,
      })
      .onConflictDoNothing({ target: customers.email })
      .returning();

    if (inserted) return inserted;

    const [customer] = await tx
      .select()
      .from(customers)
      .where(eq(customers.email, email))
      .limit(1);
    if (!customer) {
      throw new Error(`Customer ${email} disappeared after insert conflict`);
    }

    this.assertMatchingDetails(customer, input);
    return customer;
  }

  private assertMatchingDetails(
    customer: Customer,
    input: CustomerInput,
  ): void {
    if (customer.name !== input.name) {
      throw new CustomerNameMismatchError(customer.email);
    }
    if (customer.phone !== input.phone) {
      throw new CustomerPhoneMismatchError(customer.email);
    }
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
