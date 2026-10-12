/** Provider idempotency keys scoped to an order and payment operation. */
export const authorizationIdempotencyKey = (orderId: number): string =>
  `order:${orderId}:authorize`;

export const captureIdempotencyKey = (orderId: number): string =>
  `order:${orderId}:capture`;

export const voidIdempotencyKey = (orderId: number): string =>
  `order:${orderId}:void`;
