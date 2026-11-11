// ---------------------------------------------------------------------------
// Per-project expense-candidate layer -- the tenant-wall core.
//
// PURE. Turns parsed HetznerInvoice records into ONE BankTxn-shaped candidate
// PER PROJECT (never a lump) plus the Mapping the @shrug/invoiceninja write path
// consumes. It deliberately DOES NOT POST: the money-write stays the single
// audited @shrug/invoiceninja.upsertExpenses (dryRun default true). This module
// only emits pure candidates + a Mapping + a dry-run preview.
//
// CRITICAL (C1): each candidate sets direction='debit' AND status='posted' so it
// PASSES invoiceninja's isCandidate gate -- without these two fields every
// candidate is a 'non-candidate' skip and the sync writes NOTHING. isTransfer /
// isOwnerDraw are left unset (they only exclude when === true).
//
// CRITICAL (H1): hetzner-invoice is scoped USD-ONLY. invoiceninja's isCandidate
// SILENTLY drops any non-USD row, so a pre-write guard here LOUDLY THROWS on any
// detected non-USD currency AND on a mixed-currency batch -- a visible failure,
// never a silent zero-write. Non-USD expense sync is out of scope until
// isCandidate is extended; non-USD spend is still VISIBLE via the read-only
// report.
// ---------------------------------------------------------------------------

import type { HetznerInvoice } from "./parse.ts";

/** The display name bound to the Hetzner vendor id in the Mapping. */
export const HETZNER_VENDOR = "Hetzner";

/** The source tag stamped on every candidate (feeds the finops audit). */
export const CANDIDATE_SOURCE = "hetzner-invoice";

/** The IN hashid charset, mirrored here so a bad clientId is caught early. */
const HASHID_RE = /^[A-Za-z0-9]+$/;

/**
 * The resolved mapping tables the invoiceninja write path consumes (§7.3).
 * Structurally identical to @shrug/invoiceninja's `Mapping`; declared locally so
 * this extension carries no build-time dependency on that package.
 */
export interface Mapping {
  /** The IN currency hashid for USD. */
  currencyId: string;
  /** counterparty display name -> vendor hashid. */
  vendors?: Record<string, string>;
  /** rawCategory (project label) -> expense-category hashid. */
  categories?: Record<string, string>;
  /** Category hashid used when nothing else matches. */
  fallbackCategoryId: string;
}

/** Config for {@link buildExpenseCandidates} (sourced from globalArguments). */
export interface CandidatesConfig {
  /** IN currency hashid for USD (mapping.currencyId). Default "1". */
  currencyId?: string;
  /** IN vendor hashid bound to "Hetzner" (mapping.vendors). */
  vendorId?: string;
  /** IN category hashid used when a project is unmapped. */
  fallbackCategoryId?: string;
  /**
   * Passthrough tenant attribution: project label OR slug -> IN client hashid.
   * A matched project's candidate carries `clientId` so the invoiceninja
   * mapTxnToExpense passthrough writes client_id (passthrough/re-billed line);
   * an unmatched project carries no clientId (Shrug-own opex).
   */
  projectClientMap?: Record<string, string>;
  /** Per-project IN category overlay: project label OR slug -> category hashid. */
  projectCategoryMap?: Record<string, string>;
  /** Expected ISO currency for the USD-only guard. Default "USD". */
  expectedCurrency?: string;
}

/** One preview line enumerating a would-be per-project expense. */
export interface PreviewLine {
  id: string;
  invoiceNumber: string | null;
  project: string;
  slug: string;
  amount: number;
  currency: string | null;
  clientId: string | null;
  categoryId: string | null;
}

/** Output of {@link buildExpenseCandidates}. */
export interface CandidatesResult {
  /** BankTxn-shaped candidates, one per project line, ready for upsertExpenses. */
  candidates: Array<Record<string, unknown>>;
  /** The Mapping to pass alongside the candidates. */
  mapping: Mapping;
  /** A dry-run preview enumerating every per-project line. */
  preview: PreviewLine[];
}

/** Try `map[project]` then `map[slug]`; null if neither is present. */
function pickMapped(
  map: Record<string, string> | undefined,
  project: string,
  slug: string,
): string | null {
  if (!map) return null;
  if (Object.hasOwn(map, project)) return map[project];
  if (Object.hasOwn(map, slug)) return map[slug];
  return null;
}

/**
 * USD-only guard (H1). Throws LOUDLY on any detected currency other than the
 * expected one, and on a mixed-currency batch -- so a non-USD invoice fails
 * visibly instead of being silently dropped by invoiceninja's isCandidate USD
 * gate. A null/undetected currency is treated as a violation (fail closed).
 * Exported for unit testing.
 */
export function assertSingleExpectedCurrency(
  invoices: HetznerInvoice[],
  expected = "USD",
): void {
  const seen = new Set<string>();
  for (const inv of invoices) seen.add(inv.currency ?? "UNKNOWN");
  if (seen.size > 1) {
    throw new Error(
      `buildExpenseCandidates: mixed-currency batch (${
        [...seen].sort().join(", ")
      }) — refusing to build expense candidates. Run the backfill per-currency; ` +
        `only ${expected} invoices are expense-synced (H1). Non-${expected} ` +
        "spend is still visible in the read-only report.",
    );
  }
  for (const c of seen) {
    if (c !== expected) {
      throw new Error(
        `buildExpenseCandidates: detected currency "${c}" is not ${expected} — ` +
          `${expected}-only expense sync (H1). invoiceninja's isCandidate would ` +
          "silently drop it; failing loudly instead. Non-" + expected +
          " spend remains visible in the read-only report.",
      );
    }
  }
}

/**
 * Build per-project expense candidates + Mapping from parsed invoices (PURE).
 * One BankTxn-shaped candidate per Overview row; never a lump. Runs the USD-only
 * guard FIRST so a non-USD or mixed batch throws before any candidate is built.
 *
 * @throws if the batch is non-USD / mixed (see {@link assertSingleExpectedCurrency}),
 *   or if a projectClientMap value is not a valid IN hashid.
 */
export function buildExpenseCandidates(
  invoices: HetznerInvoice[],
  cfg: CandidatesConfig = {},
): CandidatesResult {
  const expected = cfg.expectedCurrency ?? "USD";
  assertSingleExpectedCurrency(invoices, expected);

  const currencyId = cfg.currencyId ?? "1";
  const fallbackCategoryId = cfg.fallbackCategoryId ?? "Uncategorized";
  const vendors: Record<string, string> = {};
  if (cfg.vendorId) vendors[HETZNER_VENDOR] = cfg.vendorId;
  const categories: Record<string, string> = {};

  const candidates: Array<Record<string, unknown>> = [];
  const preview: PreviewLine[] = [];

  for (const inv of invoices) {
    for (const line of inv.perProject) {
      const clientId = pickMapped(
        cfg.projectClientMap,
        line.project,
        line.slug,
      );
      if (clientId !== null && !HASHID_RE.test(clientId)) {
        throw new Error(
          `buildExpenseCandidates: projectClientMap value "${clientId}" for ` +
            `project "${line.project}" is not a valid IN hashid ` +
            "(/^[A-Za-z0-9]+$/).",
        );
      }
      const categoryId = pickMapped(
        cfg.projectCategoryMap,
        line.project,
        line.slug,
      );
      // Overlay the per-project category binding so mapTxnToExpense resolves
      // category_id per project (rawCategory == project label) instead of
      // collapsing every line to fallbackCategoryId.
      if (categoryId !== null) categories[line.project] = categoryId;

      const id = `hetzner:${inv.invoiceNumber ?? "unknown"}:${line.slug}`;
      const candidate: Record<string, unknown> = {
        id, // -> custom_value1 (dedup) AND transaction_reference
        source: CANDIDATE_SOURCE,
        counterparty: HETZNER_VENDOR, // -> vendor_id via mapping.vendors
        postedDate: inv.invoiceDate, // -> date
        amount: line.amount,
        direction: "debit", // C1: satisfies isCandidate
        status: "posted", // C1: satisfies isCandidate
        currency: inv.currency, // satisfies isCandidate USD gate (L1)
        rawCategory: line.project, // -> category_id via mapping.categories
        description: `Hetzner ${line.project} (invoice ${
          inv.invoiceNumber ?? "unknown"
        }${inv.period ? `, period ${inv.period}` : ""})`,
      };
      // Passthrough tenant attribution: only Shrug-passthrough projects carry a
      // clientId; Shrug-own opex lines omit it (byte-identical to pre-passthrough).
      if (clientId !== null) candidate.clientId = clientId;

      candidates.push(candidate);
      preview.push({
        id,
        invoiceNumber: inv.invoiceNumber,
        project: line.project,
        slug: line.slug,
        amount: line.amount,
        currency: inv.currency,
        clientId,
        categoryId: categoryId ?? fallbackCategoryId,
      });
    }
  }

  const mapping: Mapping = {
    currencyId,
    vendors,
    categories,
    fallbackCategoryId,
  };
  return { candidates, mapping, preview };
}
