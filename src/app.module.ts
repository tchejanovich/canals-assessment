import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './db/database.module.js';
import { OrdersModule } from './orders/orders.module.js';

@Module({
  imports: [DatabaseModule, OrdersModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
