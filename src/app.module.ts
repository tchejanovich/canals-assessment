import { Module } from '@nestjs/common';
import { DatabaseModule } from './db/database.module.js';
import { OrdersModule } from './orders/orders.module.js';

@Module({
  imports: [DatabaseModule, OrdersModule],
})
export class AppModule {}
