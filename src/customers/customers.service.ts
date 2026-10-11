import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE, type Database } from '../db/database.module.js';
import { type Customer, customers } from '../db/schema/index.js';

@Injectable()
export class CustomersService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: number): Promise<Customer | null> {
    const [row] = await this.db
      .select()
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    return row ?? null;
  }
}
