import { Module } from '@nestjs/common';
import { AddressesModule } from '../addresses/addresses.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ProductsModule } from '../products/products.module.js';
import { WarehousesModule } from '../warehouses/warehouses.module.js';
import { OrdersController } from './orders.controller.js';
import { OrderFinalizationService } from './order-finalization.service.js';
import { OrderPlacementService } from './order-placement.service.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [
    AddressesModule,
    CustomersModule,
    ProductsModule,
    WarehousesModule,
    InventoryModule,
    PaymentsModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, OrderPlacementService, OrderFinalizationService],
})
export class OrdersModule {}
