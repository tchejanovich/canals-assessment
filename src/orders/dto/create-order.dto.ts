import { z } from 'zod';

const addressSchema = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).nullish(),
  city: z.string().trim().min(1).max(100),
  region: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase()),
  postalCode: z.string().trim().min(1).max(20),
  country: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase()),
});

const itemSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().int().positive().max(1_000_000),
});

export const createOrderSchema = z.object({
  customerId: z.number().int().positive(),
  items: z
    .array(itemSchema)
    .min(1)
    .max(100)
    .refine(
      (items) =>
        new Set(items.map((item) => item.productId)).size === items.length,
      { message: 'items must not contain duplicate productId values' },
    ),
  address: addressSchema,
  creditCardNumber: z
    .string()
    .regex(/^\d{13,19}$/, 'creditCardNumber must be 13-19 digits'),
});

export type CreateOrderDto = z.infer<typeof createOrderSchema>;
export type CreateOrderAddress = z.infer<typeof addressSchema>;
export type CreateOrderItem = z.infer<typeof itemSchema>;
