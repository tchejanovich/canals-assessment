import type { Customer } from '../db/schema/index.js';
import type { CustomerResponse } from '../orders/dto/order-response.dto.js';

export function serializeCustomer(customer: Customer): CustomerResponse {
  return {
    id: customer.id,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
  };
}
