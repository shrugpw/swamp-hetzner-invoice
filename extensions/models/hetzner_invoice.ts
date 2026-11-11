// ---------------------------------------------------------------------------
// @shrug/hetzner-invoice -- turn Hetzner invoice PDFs into structured per-project
// spend data, and emit per-project Invoice Ninja expense candidates written
// through the already-gated @shrug/invoiceninja.upsertExpenses money-write.
//
// The core is SOURCE-AGNOSTIC (InvoiceSource: FileSource / BytesSource now,
// ImapSource gated on pub-4) and emits ONLY pure candidates + a dry-run preview;
// it never POSTs. The single audited money-write stays @shrug/invoiceninja.
//
// Methods:
//   - parseInvoice  : bytes/base64 (or a resolved source) -> `invoices` resource
//   - ingestFile    : a local filePath (FileSource) -> `invoices` resource
//   - buildExpenseCandidates : parsed invoice(s) (via CEL) -> `expenseCandidates`
//                     resource { candidates, mapping, preview } -- USD-only (H1)
// ---------------------------------------------------------------------------

import { z } from "npm:zod@4";
import { extractPdfText } from "./_lib/pdf.ts";
import { type HetznerInvoice, parseHetznerInvoice } from "./_lib/parse.ts";
import {
  type InvoiceSource,
  resolveSource,
  type SourceInput,
} from "./_lib/sources.ts";
import {
  buildExpenseCandidates as buildCandidates,
  type CandidatesConfig,
} from "./_lib/expenses.ts";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  defaultFilePath: z
    .string()
    .optional()
    .describe("Default local PDF path for ingestFile when none is given."),
  expectedCurrency: z
    .string()
    .default("USD")
    .describe(
      "ISO currency the USD-only expense guard enforces (H1). A detected " +
        "currency other than this, or a mixed-currency batch, makes " +
        "buildExpenseCandidates THROW (loud) instead of silently writing " +
        "nothing. Non-matching spend is still visible in the read-only report.",
    ),
  currencyId: z
    .string()
    .default("1")
    .describe("Invoice Ninja currency hashid for USD (mapping.currencyId)."),
  vendorId: z
    .string()
    .optional()
    .describe(
      "Invoice Ninja vendor hashid bound to 'Hetzner' (mapping.vendors). " +
        "Absent -> vendor_id resolves null (allowed; flagged unmatchedVendor).",
    ),
  fallbackCategoryId: z
    .string()
    .default("Uncategorized")
    .describe("IN category hashid used when a project is unmapped."),
  projectClientMap: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      "Passthrough tenant attribution: project label OR slug -> IN client " +
        "hashid. A matched project's candidate carries clientId so the " +
        "invoiceninja passthrough writes client_id; unmatched projects are " +
        "Shrug-own opex (no clientId).",
    ),
  projectCategoryMap: z
    .record(z.string(), z.string())
    .default({})
    .describe("Per-project IN category overlay: project label OR slug -> id."),
  dryRun: z
    .boolean()
    .default(true)
    .describe(
      "Default true. This model NEVER POSTs regardless; the real money-write " +
        "is @shrug/invoiceninja.upsertExpenses (also dryRun default true). A " +
        "live expense POST needs that model's explicit dryRun=false + sign-off.",
    ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const ProjectLineSchema = z.object({
  project: z.string(),
  slug: z.string(),
  amount: z.number(),
});

const HetznerInvoiceSchema = z.object({
  invoiceNumber: z.string().nullable(),
  customerId: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  period: z.string().nullable(),
  currency: z.string().nullable(),
  perProject: z.array(ProjectLineSchema),
  netExclVat: z.number().nullable(),
  tax: z.number().nullable(),
  total: z.number().nullable(),
  retrievedAt: z.string(),
});

const PreviewLineSchema = z.object({
  id: z.string(),
  invoiceNumber: z.string().nullable(),
  project: z.string(),
  slug: z.string(),
  amount: z.number(),
  currency: z.string().nullable(),
  clientId: z.string().nullable(),
  categoryId: z.string().nullable(),
});

const ExpenseCandidatesSchema = z.object({
  candidates: z.array(z.record(z.string(), z.unknown())),
  mapping: z.record(z.string(), z.unknown()),
  preview: z.array(PreviewLineSchema),
  dryRun: z.boolean(),
  expectedCurrency: z.string(),
  retrievedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Execution seams (mirrors the shared extension runtime shape)
// ---------------------------------------------------------------------------

interface MethodLogger {
  info(message: string, properties?: Record<string, unknown>): void;
  warning(message: string, properties?: Record<string, unknown>): void;
}

/** Low-level data API the runtime provides (same surface the report uses). */
interface DataRepo {
  findAllForModel(
    type: unknown,
    modelId: string,
  ): Promise<Array<{ name: string; version: number }>>;
  getContent(
    type: unknown,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
}

interface ExecuteContext {
  globalArgs: GlobalArgs;
  logger: MethodLogger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  // Model identity + low-level data API (optional; provided by the runtime).
  // buildExpenseCandidates uses them to read the model's OWN latest `invoices`
  // resources when no explicit invoices arg is passed.
  modelType?: unknown;
  modelId?: string;
  dataRepository?: DataRepo;
}

interface ExecuteResult {
  dataHandles: Array<{ name: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A filesystem-safe instance name for an invoice resource. */
export function invoiceResourceName(inv: HetznerInvoice): string {
  const base = (inv.invoiceNumber ?? "invoice")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "invoice";
}

/** Never-throw coercion of an untyped record into a {@link HetznerInvoice}. */
export function decodeInvoice(
  raw: Record<string, unknown>,
): HetznerInvoice {
  const strOrNull = (v: unknown) => (typeof v === "string" ? v : null);
  const numOrNull = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const perProject = Array.isArray(raw.perProject)
    ? raw.perProject.flatMap((r) => {
      if (typeof r !== "object" || r === null) return [];
      const rr = r as Record<string, unknown>;
      const project = strOrNull(rr.project);
      const slug = strOrNull(rr.slug);
      const amount = numOrNull(rr.amount);
      if (project === null || slug === null || amount === null) return [];
      return [{ project, slug, amount }];
    })
    : [];
  return {
    invoiceNumber: strOrNull(raw.invoiceNumber),
    customerId: strOrNull(raw.customerId),
    invoiceDate: strOrNull(raw.invoiceDate),
    period: strOrNull(raw.period),
    currency: strOrNull(raw.currency),
    perProject,
    netExclVat: numOrNull(raw.netExclVat),
    tax: numOrNull(raw.tax),
    total: numOrNull(raw.total),
  };
}

/** Parse a source's bytes into a HetznerInvoice and write the `invoices` resource. */
async function ingest(
  source: InvoiceSource,
  context: ExecuteContext,
): Promise<ExecuteResult> {
  const bytes = await source.fetchBytes();
  const text = await extractPdfText(bytes);
  const inv = parseHetznerInvoice(text);
  context.logger.info(
    "Parsed Hetzner invoice {number}: {n} project line(s), currency {cur}",
    {
      number: inv.invoiceNumber ?? "(unknown)",
      n: inv.perProject.length,
      cur: inv.currency ?? "(undetected)",
    },
  );
  const handle = await context.writeResource(
    "invoices",
    invoiceResourceName(inv),
    { ...inv, retrievedAt: new Date().toISOString() },
  );
  return { dataHandles: [handle] };
}

/** Collect the invoice records from a buildExpenseCandidates method input. */
function collectInvoices(
  args: { invoices?: unknown; invoice?: unknown },
): HetznerInvoice[] {
  const out: HetznerInvoice[] = [];
  if (Array.isArray(args.invoices)) {
    for (const r of args.invoices) {
      if (typeof r === "object" && r !== null) {
        out.push(decodeInvoice(r as Record<string, unknown>));
      }
    }
  }
  if (typeof args.invoice === "object" && args.invoice !== null) {
    out.push(decodeInvoice(args.invoice as Record<string, unknown>));
  }
  return out;
}

/** True when a JSON-decoded record is an `invoices` resource (not candidates). */
function looksLikeInvoiceRecord(r: Record<string, unknown>): boolean {
  return Array.isArray(r.perProject) && "invoiceNumber" in r;
}

/**
 * Read the model's OWN latest `invoices` resources via the runtime data API
 * (the "reads the latest invoices resource" path). Shape-filters so the
 * `expenseCandidates` resource is never mistaken for an invoice.
 */
async function readOwnInvoices(
  context: ExecuteContext,
): Promise<HetznerInvoice[]> {
  const repo = context.dataRepository;
  if (!repo || context.modelId === undefined) return [];
  const metas = await repo.findAllForModel(context.modelType, context.modelId);
  const out: HetznerInvoice[] = [];
  for (const m of metas) {
    const bytes = await repo.getContent(
      context.modelType,
      context.modelId,
      m.name,
      m.version,
    );
    if (!bytes) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      continue;
    }
    if (
      typeof obj === "object" && obj !== null &&
      looksLikeInvoiceRecord(obj as Record<string, unknown>)
    ) {
      out.push(decodeInvoice(obj as Record<string, unknown>));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

export const model = {
  type: "@shrug/hetzner-invoice",
  version: "2026.11.10.1",
  description:
    "Turn Hetzner invoice PDFs into structured per-project spend data and emit " +
    "per-project Invoice Ninja expense candidates (written through the gated " +
    "@shrug/invoiceninja.upsertExpenses money-write). Source-agnostic " +
    "(FileSource/BytesSource now; ImapSource gated on pub-4). USD-only expense " +
    "sync (H1): a non-USD or mixed-currency batch throws loudly rather than " +
    "silently writing nothing; non-USD spend stays visible in the read-only " +
    "hetzner-spend report. This model NEVER POSTs -- it emits pure candidates " +
    "plus a dry-run preview.",
  globalArguments: GlobalArgsSchema,
  resources: {
    "invoices": {
      description:
        "A parsed Hetzner invoice: number, customer id, date, period, detected " +
        "ISO currency, per-project subtotals, and net/VAT/total figures.",
      schema: HetznerInvoiceSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    "expenseCandidates": {
      description:
        "Per-project BankTxn-shaped expense candidates + the Mapping, plus a " +
        "dry-run preview enumerating every line. Consumed by " +
        "@shrug/invoiceninja.upsertExpenses via CEL. No POST happens here.",
      schema: ExpenseCandidatesSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    parseInvoice: {
      description:
        "Parse PDF invoice bytes (inline base64 via bytesBase64, a filePath, " +
        "or a resolved source) into the `invoices` resource. Runs the bundled " +
        "pdf text extractor + the anchor parser. Detects and persists the ISO " +
        "currency from the document.",
      arguments: z.object({
        bytesBase64: z.string().optional().describe(
          "Inline base64-encoded PDF bytes (BytesSource).",
        ),
        filePath: z.string().optional().describe(
          "Local filesystem path to a PDF (FileSource).",
        ),
        imap: z.object({
          folder: z.string().optional(),
          uid: z.number().optional(),
          filename: z.string().optional(),
        }).optional().describe(
          "IMAP attachment reference (ImapSource) -- GATED on pub-4; throws.",
        ),
      }),
      execute: async (
        args: SourceInput & { _source?: InvoiceSource },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const source = args._source ?? resolveSource(args);
        return await ingest(source, context);
      },
    },
    ingestFile: {
      description:
        "Parse a local PDF invoice (FileSource) into the `invoices` resource. " +
        "Uses globalArguments.defaultFilePath when no filePath is given.",
      arguments: z.object({
        filePath: z.string().optional().describe(
          "Local PDF path; defaults to globalArguments.defaultFilePath.",
        ),
      }),
      execute: async (
        args: { filePath?: string; _source?: InvoiceSource },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const path = args.filePath ?? context.globalArgs.defaultFilePath;
        if (args._source === undefined && path === undefined) {
          throw new Error(
            "ingestFile: no filePath given and no globalArguments.defaultFilePath.",
          );
        }
        const source = args._source ?? resolveSource({ filePath: path });
        return await ingest(source, context);
      },
    },
    buildExpenseCandidates: {
      description:
        "Build per-project expense candidates + Mapping from parsed invoice(s). " +
        "Invoices come from the `invoices`/`invoice` arg (via CEL) OR, when none " +
        "is passed, from the model's OWN latest `invoices` resources. USD-only " +
        "(H1): a non-USD or mixed-currency batch THROWS. Writes the " +
        "`expenseCandidates` resource; never POSTs. Feed candidates+mapping to " +
        "@shrug/invoiceninja.upsertExpenses.",
      arguments: z.object({
        invoices: z.array(z.record(z.string(), z.unknown())).optional()
          .describe("Parsed invoice records (via CEL data.latest)."),
        invoice: z.record(z.string(), z.unknown()).optional().describe(
          "A single parsed invoice record (convenience).",
        ),
      }),
      execute: async (
        args: { invoices?: unknown; invoice?: unknown },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        let invoices = collectInvoices(args);
        if (invoices.length === 0) {
          // No explicit arg -> read the model's own latest invoices resources.
          invoices = await readOwnInvoices(context);
        }
        if (invoices.length === 0) {
          throw new Error(
            "buildExpenseCandidates: no invoices given and none found in the " +
              "model's own `invoices` resources — run parseInvoice/ingestFile " +
              "first, or pass `invoices`/`invoice` via CEL.",
          );
        }
        const candCfg: CandidatesConfig = {
          currencyId: cfg.currencyId,
          vendorId: cfg.vendorId,
          fallbackCategoryId: cfg.fallbackCategoryId,
          projectClientMap: cfg.projectClientMap,
          projectCategoryMap: cfg.projectCategoryMap,
          expectedCurrency: cfg.expectedCurrency,
        };
        // buildCandidates runs the USD-only guard FIRST; a non-USD/mixed batch
        // throws here, before any resource is written.
        const { candidates, mapping, preview } = buildCandidates(
          invoices,
          candCfg,
        );
        context.logger.info(
          "Built {n} per-project expense candidate(s) across {i} invoice(s)",
          { n: candidates.length, i: invoices.length },
        );
        const handle = await context.writeResource(
          "expenseCandidates",
          "candidates",
          {
            candidates,
            mapping,
            preview,
            dryRun: cfg.dryRun,
            expectedCurrency: cfg.expectedCurrency,
            retrievedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
