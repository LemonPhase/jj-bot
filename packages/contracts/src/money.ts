// US dollar amounts as people read them. A module of its own, with no
// imports, so every schema module can use it without an import cycle;
// `usage.ts` re-exports it.

/** At most `places` decimals, trailing zeros dropped down to cents. */
function fixedUsd(usd: number, places: number): string {
  const [whole, fraction = ""] = usd.toFixed(places).split(".");
  return `$${whole}.${fraction.replace(/0+$/, "").padEnd(2, "0")}`;
}

const placesFor = (usd: number) => (usd >= 1 ? 2 : usd >= 0.01 ? 4 : 6);

/**
 * US dollars as people read them: cents from a dollar up, else up to four
 * places (six below a cent) without trailing zeros. "$5.00", "$0.035",
 * "$0.004789". The server's messages and the clients use the same one.
 */
export function formatUsd(usd: number): string {
  return fixedUsd(usd, placesFor(usd));
}

const shownValue = (text: string) => Number(text.slice(1));

/**
 * Spend next to a cap, each as `formatUsd` shows it unless that would make
 * them compare differently from what they are: then both get more places,
 * so spend over a cap never reads as at or under it, and under never as at
 * or over. "$4.996 of $5.00", "$0.015 of $0.01".
 */
export function formatSpendAgainstCap(
  spentUsd: number,
  capUsd: number,
): { spent: string; cap: string } {
  const order = Math.sign(spentUsd - capUsd);
  let spent = formatUsd(spentUsd);
  let cap = formatUsd(capUsd);
  for (
    let places = Math.max(placesFor(spentUsd), placesFor(capUsd));
    Math.sign(shownValue(spent) - shownValue(cap)) !== order && places <= 12;
    places += 1
  ) {
    spent = fixedUsd(spentUsd, places);
    cap = fixedUsd(capUsd, places);
  }
  return { spent, cap };
}
