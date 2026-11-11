// ---------------------------------------------------------------------------
// Anchor-based Hetzner-invoice parser: extracted text -> typed HetznerInvoice.
//
// Pure text-in / struct-out, fully unit-testable against SYNTHETIC fixtures. It
// keys ONLY on structural text anchors (never on any real sample value): the
// "Invoice no."/"Invoice number" line, the "Invoice date" line (DD/MM/YYYY), the
// "Customer ID" line, the billing "Period" line, the currency read FROM the
// document (ISO code or symbol), the "Overview" per-project table rows
// (project label -> amount), and the net/VAT/total summary. The detected ISO
// currency is persisted so the report can show it AND the USD-only expense guard
// can enforce it (H1). Tolerant of surrounding whitespace and label punctuation.
// ---------------------------------------------------------------------------

/** One Overview-table row: a project and its amount (net, excl VAT). */
export interface HetznerProjectLine {
  /** The project label exactly as printed in the Overview table. */
  project: string;
  /**
   * A URL-safe slug of `project`, GUARANTEED injective within one invoice
   * (collisions are disambiguated with a numeric suffix — F5) so the downstream
   * dedup key `hetzner:<invoiceNo>:<slug>` never collapses two distinct lines.
   */
  slug: string;
  /** The project subtotal (net, excl VAT). */
  amount: number;
}

/** A parsed Hetzner invoice. Nulls where an anchor was not found. */
export interface HetznerInvoice {
  invoiceNumber: string | null;
  customerId: string | null;
  /** Normalized ISO `YYYY-MM-DD` (parsed from the printed `DD/MM/YYYY`). */
  invoiceDate: string | null;
  /** The billing period, verbatim (e.g. a month or a date range). */
  period: string | null;
  /** Detected ISO-4217 currency (e.g. `USD`, `EUR`), or null if undetectable. */
  currency: string | null;
  perProject: HetznerProjectLine[];
  /** Net total excl VAT (invoice level). */
  netExclVat: number | null;
  /** VAT / tax amount. */
  tax: number | null;
  /** Gross total. */
  total: number | null;
}

/** Symbol -> ISO code for the currencies Hetzner bills in. */
const SYMBOL_ISO: Record<string, string> = {
  "$": "USD",
  "€": "EUR",
  "£": "GBP",
};

/**
 * Parse an amount token to a number, or null when it is not a well-formed
 * decimal. Handles BOTH US (`1,234.56`) and EU (`1.234,56` / `17,50`) number
 * formats so a non-USD invoice's per-project spend is still parseable for the
 * read-only report (expense sync is USD-only regardless). Heuristic: when both
 * separators are present, the LAST one is the decimal point; a lone comma with
 * other than 3 trailing digits is a decimal comma, else a thousands separator.
 * A trailing/leading currency symbol or ISO code is tolerated.
 */
export function parseAmount(raw: string): number | null {
  const m = raw.match(/-?\d[\d.,]*\d|-?\d/);
  if (!m) return null;
  const neg = m[0].startsWith("-");
  const tok = m[0].replace(/^-/, "");
  const lastComma = tok.lastIndexOf(",");
  const lastDot = tok.lastIndexOf(".");
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: the later separator is the decimal point.
    normalized = lastComma > lastDot
      ? tok.replace(/\./g, "").replace(",", ".")
      : tok.replace(/,/g, "");
  } else if (lastComma >= 0) {
    const after = tok.length - lastComma - 1;
    const single = (tok.match(/,/g) ?? []).length === 1;
    normalized = single && after !== 3
      ? tok.replace(",", ".") // decimal comma (e.g. 17,50)
      : tok.replace(/,/g, ""); // thousands commas
  } else {
    normalized = tok; // dot-only: dot is the decimal point
  }
  const n = Number((neg ? "-" : "") + normalized);
  return Number.isFinite(n) ? n : null;
}

/** Slugify a project label: lowercase, non-alnum -> `-`, trimmed + collapsed. */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/** Normalize a printed `DD/MM/YYYY` date to ISO `YYYY-MM-DD`; null if unparsable. */
export function normalizeDate(raw: string): string | null {
  const m = raw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

/** First capture group of `re` over `text`, trimmed, or null. */
function firstMatch(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m && m[1] ? m[1].trim() : null;
}

/**
 * Detect the ISO-4217 currency from the document. Prefers an explicit ISO code
 * (USD/EUR/GBP) anywhere in the text; falls back to a currency symbol. Returns
 * null when neither is present (the USD-only guard then rejects the batch
 * loudly rather than silently assuming a currency).
 */
export function detectCurrency(text: string): string | null {
  const iso = text.match(/\b(USD|EUR|GBP)\b/);
  if (iso) return iso[1];
  for (const [sym, code] of Object.entries(SYMBOL_ISO)) {
    if (text.includes(sym)) return code;
  }
  return null;
}

/** A totals line keyword (ends the Overview table). */
const NET_RE = /\b(?:net\s+total|total\s+excl|subtotal|net\s+amount)\b/i;
const TAX_RE = /\b(?:VAT|tax|sales\s*tax)\b/i;
const TOTAL_RE = /\b(?:total)\b/i;

/** A row that is amount-bearing: a trailing US/EU number, optional symbol/ISO. */
const ROW_RE = /^(.*?)\s+(-?\d[\d.,]*\d|-?\d)\s*(?:[A-Z]{3}|[$€£])?\.?$/;

/**
 * Parse extracted invoice text into a {@link HetznerInvoice}. Line-structured:
 * the Overview region is the lines between the `Overview` header and the first
 * totals line; each non-totals amount-bearing line in that region is one
 * per-project row. Project slugs are made injective within the invoice (F5).
 */
export function parseHetznerInvoice(text: string): HetznerInvoice {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) =>
    l.length > 0
  );

  const invoiceNumber = firstMatch(
    text,
    /Invoice\s+(?:no\.?|number)\s*:?\s*([^\s].*?)\s*$/im,
  );
  const customerId = firstMatch(text, /Customer\s+ID\s*:?\s*([^\s].*?)\s*$/im);
  const dateRaw = firstMatch(
    text,
    /Invoice\s+date\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i,
  );
  const invoiceDate = dateRaw ? normalizeDate(dateRaw) : null;
  const period = firstMatch(text, /Period\s*:?\s*([^\s].*?)\s*$/im);
  const currency = detectCurrency(text);

  // Locate the Overview table header.
  const overviewIdx = lines.findIndex((l) => /^Overview\b/i.test(l));
  const perProject: HetznerProjectLine[] = [];
  let netExclVat: number | null = null;
  let tax: number | null = null;
  let total: number | null = null;

  if (overviewIdx >= 0) {
    let inTable = true;
    for (let i = overviewIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      const rowMatch = line.match(ROW_RE);
      const isNet = NET_RE.test(line);
      const isTax = TAX_RE.test(line);
      const isTotal = TOTAL_RE.test(line);
      // A totals keyword closes the per-project table; capture the summary
      // figures from the totals block that follows.
      if (isNet || isTax || isTotal) {
        inTable = false;
        const amt = rowMatch ? parseAmount(rowMatch[2]) : parseAmount(line);
        if (isNet && netExclVat === null) netExclVat = amt;
        else if (isTax && tax === null) tax = amt;
        else if (isTotal && total === null) total = amt;
        continue;
      }
      if (inTable && rowMatch) {
        const label = rowMatch[1].trim();
        const amount = parseAmount(rowMatch[2]);
        if (label.length > 0 && amount !== null) {
          perProject.push({ project: label, slug: slugify(label), amount });
        }
      }
    }
  }

  dedupeSlugs(perProject);
  return {
    invoiceNumber,
    customerId,
    invoiceDate,
    period,
    currency,
    perProject,
    netExclVat,
    tax,
    total,
  };
}

/**
 * Guarantee slug injectivity WITHIN one invoice (F5 dedup-key collision guard):
 * if two Overview rows reduce to the same slug (or a blank slug), disambiguate
 * by appending `-2`, `-3`, ... in row order so `hetzner:<invoiceNo>:<slug>`
 * stays unique and no project line is silently deduped away.
 */
export function dedupeSlugs(lines: HetznerProjectLine[]): void {
  const seen = new Map<string, number>();
  for (const line of lines) {
    const base = line.slug || "project";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    line.slug = count === 0 ? base : `${base}-${count + 1}`;
  }
}
