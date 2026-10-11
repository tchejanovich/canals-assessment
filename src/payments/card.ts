/**
 * Last four digits of a card number, stripped of any separators. Shared by the
 * payment provider mock and the order flow (which stores the digits alongside
 * the payment record before the authorization round-trip).
 */
export function cardLast4(creditCardNumber: string): string {
  return creditCardNumber.replace(/\D/g, '').slice(-4);
}
