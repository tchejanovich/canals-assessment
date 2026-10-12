/** Returns a card's last four digits; request validation ensures digits only. */
export function cardLast4(creditCardNumber: string): string {
  return creditCardNumber.slice(-4);
}
