import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  createOrderSchema,
  type CreateOrderDto,
} from './dto/create-order.dto.js';
import type { OrderResponse } from './dto/order-response.dto.js';
import { OrdersService } from './orders.service.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  async create(
    @Body(new ZodValidationPipe(createOrderSchema)) body: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderResponse> {
    if (!idempotencyKey) {
      throw new BadRequestException(
        'Idempotency-Key header is required to create an order',
      );
    }
    const { order, created } = await this.ordersService.createOrder(
      body,
      idempotencyKey,
    );
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return order;
  }
}
