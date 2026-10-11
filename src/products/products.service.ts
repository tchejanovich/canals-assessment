import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { DATABASE, type Database } from '../db/database.module.js';
import { type Product, products } from '../db/schema/index.js';

@Injectable()
export class ProductsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findByIds(ids: number[]): Promise<Product[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.db.select().from(products).where(inArray(products.id, ids));
  }
}
