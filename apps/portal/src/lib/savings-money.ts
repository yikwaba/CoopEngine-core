/** Convert decimal input within the API's existing safe numeric boundary. */
export function savingsAmount(value: string): number {
  const text = value.trim();
  if (text.length > 24 || !/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new Error('Enter an amount with up to two decimal places.');
  }
  const [whole, fraction = ''] = text.split('.');
  const kobo = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (kobo < 1n || kobo > 10_000_000_000_000n) {
    throw new Error('Amount must be between ₦0.01 and ₦100,000,000,000.00.');
  }
  return Number(text);
}
