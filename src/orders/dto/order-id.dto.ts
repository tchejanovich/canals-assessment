import { z } from 'zod';

export const orderIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'Order id must be a positive integer')
  .transform(Number)
  .refine(Number.isSafeInteger, 'Order id must be a safe integer');
