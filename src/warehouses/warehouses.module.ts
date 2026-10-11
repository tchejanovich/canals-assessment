import { Module } from '@nestjs/common';
import { WarehousesService } from './warehouses.service.js';

@Module({
  providers: [WarehousesService],
  exports: [WarehousesService],
})
export class WarehousesModule {}
