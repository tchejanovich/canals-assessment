import { Injectable, Logger } from '@nestjs/common';
import type { CreateOrderDto } from './dto/create-order.dto.js';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  createOrder(order: CreateOrderDto): CreateOrderDto {
    this.logger.log(`Received order: ${JSON.stringify(order)}`);
    return order;
  }
}
