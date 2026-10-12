import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  createOrderSchema,
  type CreateOrderDto,
} from './dto/create-order.dto.js';
import { orderIdSchema } from './dto/order-id.dto.js';
import type { OrderResponse } from './dto/order-response.dto.js';
import { toHttpException } from './orders.exception-mapper.js';
import { OrdersService } from './orders.service.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

@Controller('orders')
export class OrdersController {
  private readonly validateBody = new ZodValidationPipe(createOrderSchema);
  private readonly validateOrderId = new ZodValidationPipe(orderIdSchema);

  constructor(private readonly ordersService: OrdersService) {}

  @Get(':id')
  async getById(@Param('id') id: string): Promise<OrderResponse> {
    try {
      const orderId = this.validateOrderId.transform(id) as number;
      return await this.ordersService.getOrderById(orderId);
    } catch (error) {
      throw toHttpException(error);
    }
  }

  @Post()
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderResponse> {
    try {
      const dto = this.validateBody.transform(body) as CreateOrderDto;
      const { order, created } = await this.ordersService.createOrder(
        dto,
        idempotencyKey,
      );
      res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
      return order;
    } catch (error) {
      throw toHttpException(error);
    }
  }
}
