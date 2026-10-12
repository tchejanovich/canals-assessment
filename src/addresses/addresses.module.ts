import { Module } from '@nestjs/common';
import { GeocodingModule } from '../geocoding/geocoding.module.js';
import { AddressesService } from './addresses.service.js';

@Module({
  imports: [GeocodingModule],
  providers: [AddressesService],
  exports: [AddressesService],
})
export class AddressesModule {}
