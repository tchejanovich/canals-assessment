import { Module } from '@nestjs/common';
import { AddressesService } from './addresses.service.js';

@Module({
  providers: [AddressesService],
  exports: [AddressesService],
})
export class AddressesModule {}
