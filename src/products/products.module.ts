import { Module } from '@nestjs/common';
import { ProductsService } from './products.service.js';

@Module({
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
