import { Module } from '@nestjs/common';
import { GeocodingService } from './geocoding.service.js';

@Module({
  providers: [GeocodingService],
  exports: [GeocodingService],
})
export class GeocodingModule {}
