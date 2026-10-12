/**
 * Last four digits of a card number. Input validation at the request boundary
 * ensures the value contains only digits.
 */
export function cardLast4(creditCardNumber: string): string {
  return creditCardNumber.slice(-4);
}
