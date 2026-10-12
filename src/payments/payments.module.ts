import { Module } from '@nestjs/common';
import { PaymentsApi } from './payments.api.js';
import { PaymentsService } from './payments.service.js';

@Module({
  providers: [PaymentsApi, PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
