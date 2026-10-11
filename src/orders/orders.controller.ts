import { Body, Controller, Post } from '@nestjs/common';
import type { CreateOrderDto } from './dto/create-order.dto.js';
import { OrdersService } from './orders.service.js';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  create(@Body() body: CreateOrderDto): CreateOrderDto {
    return this.ordersService.createOrder(body);
  }
}
