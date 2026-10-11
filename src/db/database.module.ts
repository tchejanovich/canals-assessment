import {
  Global,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { resolve } from 'node:path';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema/index.js';

export type Database = PostgresJsDatabase<typeof schema>;

export type DatabaseTransaction = Parameters<
  Parameters<Database['transaction']>[0]
>[0];

export const DATABASE = Symbol('DATABASE');

@Injectable()
export class DatabaseConnection implements OnModuleInit, OnApplicationShutdown {
  private readonly client: Sql;
  readonly db: Database;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    this.client = postgres(connectionString, { max: 10 });
    this.db = drizzle(this.client, { schema });
  }

  async onModuleInit(): Promise<void> {
    await migrate(this.db, {
      migrationsFolder: resolve(process.cwd(), 'drizzle'),
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}

@Global()
@Module({
  providers: [
    DatabaseConnection,
    {
      provide: DATABASE,
      useFactory: (connection: DatabaseConnection): Database =>
        connection.db,
      inject: [DatabaseConnection],
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}
