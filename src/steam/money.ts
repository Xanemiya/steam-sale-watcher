function isFreeish(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("free") ||
    t.includes("kostenlos") ||
    t.includes("gratis") ||
    t.includes("play for free") ||
    t.includes("бесплатно") ||
    t.includes("бесплатная игра") ||
    t.includes("бесплатная")
  );
}

/**
 * Parse localized money string into { value, currency }.
 * Handles "19,99€", "€19,99", "$19.99", "1.299,99 €", "19.99 USD", "Gratis"
 */
export function parseMoney(text?: string): { value?: number; currency?: string } {
  if (!text) return {};
  const raw = text.trim();
  if (!raw) return {};
  if (isFreeish(raw)) return { value: 0 };

  // Primary: currency can be before OR after the number
  const match = raw.match(
    /^(?:([€£$₽¥₩₺]|US\$|CDN\$|R\$|A\$|C\$|CHF|zł|kr))?\s*([\d.,]+)\s*(?:([€£$₽¥₩₺]|[A-Z]{2,3}|TL|руб|₽))?$/
  );

  if (!match) {
    // Loose path: pick number + any currency token we can find
    const numOnly = raw.match(/([\d][\d.,]*)/);
    const curOnly = raw.match(/(€|£|\$|₽|¥|₩|₺|CHF|USD|EUR|TL|руб|₽)/i);
    const maybeCur: string | undefined = curOnly?.[1] ?? curOnly?.[0];

    if (!numOnly) return typeof maybeCur === "string" ? { currency: maybeCur } : {};

    const numStr = numOnly[1] ?? numOnly[0];
    if (!numStr) return typeof maybeCur === "string" ? { currency: maybeCur } : {};

    return normalizeNumber(numStr, maybeCur);
  }

  const [, cur1, num, cur2] = match;
  const currency = (cur1 || cur2) as string | undefined;
  return normalizeNumber(num ?? "", currency);
}

export function normalizeNumber(num: string, currency?: string): { value?: number; currency?: string } {
  let n = num;
  const hasComma = n.includes(",");
  const hasDot = n.includes(".");

  if (hasComma && hasDot) {
    // "1.299,99" → "1299.99"
    n = n.replace(/\./g, "").replace(",", ".");
  } else if (hasComma && !hasDot) {
    // "19,99" → "19.99"
    n = n.replace(",", ".");
  }

  const value = Number(n);
  if (!Number.isFinite(value)) return typeof currency === "string" ? { currency } : {};
  return typeof currency === "string" ? { value, currency } : { value };
}

export function computePctFromPrices(oldP?: number, newP?: number): number | undefined {
  if (oldP == null || newP == null) return;
  if (!(oldP > 0) || !(newP <= oldP)) return;
  const pct = Math.round((1 - newP / oldP) * 100);
  return pct >= 0 && pct <= 100 ? pct : undefined;
}

export { isFreeish }; // re-export for parse.ts
