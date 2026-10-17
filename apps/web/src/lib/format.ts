const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export const formatCents = (cents: number) => usd.format(cents / 100);
export const dollarsToCents = (dollars: string) => Math.round(Number(dollars || 0) * 100);
export const centsToDollars = (cents: number) => (cents / 100).toFixed(2);
