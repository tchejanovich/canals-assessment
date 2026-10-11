import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module.js';
import { GeocodingModule } from '../geocoding/geocoding.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ProductsModule } from '../products/products.module.js';
import { WarehousesModule } from '../warehouses/warehouses.module.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [
    CustomersModule,
    ProductsModule,
    GeocodingModule,
    WarehousesModule,
    InventoryModule,
    PaymentsModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
