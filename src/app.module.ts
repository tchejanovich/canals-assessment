import { Module } from '@nestjs/common';
import { DatabaseModule } from './db/database.module.js';
import { HealthModule } from './health/health.module.js';
import { OrdersModule } from './orders/orders.module.js';

@Module({
  imports: [DatabaseModule, OrdersModule, HealthModule],
})
export class AppModule {}
