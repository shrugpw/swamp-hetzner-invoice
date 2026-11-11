// ---------------------------------------------------------------------------
// @shrug/hetzner-invoice tests. SYNTHETIC fixtures ONLY (see _fixtures).
//
// The tenant-wall assertion drives the REAL @shrug/invoiceninja write entrypoint
// END-TO-END (NOT mapTxnToExpense standalone, which bypasses the isCandidate
// gate): it imports upsertExpense + Mapping from the installed, EXTENDED
// @shrug/invoiceninja and runs it with an injected doFetch (the FetchLike seam)
// at dryRun=false, capturing the POST body the stub receives. The stub also
// answers the pre-POST paginated dedup GET /expenses with an empty page (F3) so
// the `created` path is actually reached.
// ---------------------------------------------------------------------------

import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { PDFDocument, StandardFonts } from "npm:pdf-lib@1.17.1";

import {
  dedupeSlugs,
  detectCurrency,
  type HetznerInvoice,
  normalizeDate,
  parseAmount,
  parseHetznerInvoice,
  slugify,
} from "./_lib/parse.ts";
import { extractPdfText, looksLikePdf } from "./_lib/pdf.ts";
import {
  BytesSource,
  FileSource,
  ImapSource,
  resolveSource,
} from "./_lib/sources.ts";
import {
  assertSingleExpectedCurrency,
  buildExpenseCandidates,
  type CandidatesConfig,
} from "./_lib/expenses.ts";
import { decodeInvoice, invoiceResourceName } from "./hetzner_invoice.ts";

// The REAL, extended invoiceninja write path (this branch's working tree).
import {
  type FetchLike,
  type Mapping,
  upsertExpense,
} from "../../../invoiceninja/extensions/models/invoiceninja.ts";

import {
  PASSTHROUGH_CLIENT_ID,
  PASSTHROUGH_PROJECT,
  SYNTHETIC_EUR_TEXT,
  SYNTHETIC_SLUG_COLLISION_TEXT,
  SYNTHETIC_USD_TEXT,
  SYNTHETIC_USD_TEXT_2,
} from "./_fixtures/synthetic_invoice_text.ts";

// ===========================================================================
// Parser
// ===========================================================================

Deno.test("parseHetznerInvoice: extracts scalar anchors", () => {
  const inv = parseHetznerInvoice(SYNTHETIC_USD_TEXT);
  assertEquals(inv.invoiceNumber, "SYNTH-2026-0001");
  assertEquals(inv.customerId, "K0000000000");
  assertEquals(inv.invoiceDate, "2026-11-10"); // 10/11/2026 DD/MM/YYYY -> ISO
  assertEquals(inv.period, "October 2026");
  assertEquals(inv.currency, "USD");
});

Deno.test("parseHetznerInvoice: one line per project (never a lump)", () => {
  const inv = parseHetznerInvoice(SYNTHETIC_USD_TEXT);
  assertEquals(inv.perProject.length, 3);
  assertEquals(inv.perProject.map((p) => p.project), [
    "acme-passthrough-web",
    "shrug-core-infra",
    "shrug-lab-sandbox",
  ]);
  assertEquals(inv.perProject.map((p) => p.amount), [42.0, 17.5, 5.0]);
});

Deno.test("parseHetznerInvoice: per-project subtotals reconcile with the net total", () => {
  const inv = parseHetznerInvoice(SYNTHETIC_USD_TEXT);
  const sum = inv.perProject.reduce((a, p) => a + p.amount, 0);
  assertEquals(Math.round(sum * 100) / 100, inv.netExclVat);
  assertEquals(inv.total, 64.5);
});

Deno.test("parseHetznerInvoice: detects EUR and parses comma-decimal amounts", () => {
  const inv = parseHetznerInvoice(SYNTHETIC_EUR_TEXT);
  assertEquals(inv.currency, "EUR");
  assertEquals(inv.perProject.length, 1);
  // "17,50" (EU decimal comma) parses as 17.5 so EUR spend is visible in the
  // read-only report, even though EUR expense sync is rejected by the guard.
  assertEquals(inv.perProject[0].amount, 17.5);
});

Deno.test("slugify + dedupeSlugs: N distinct keys for N rows (F5)", () => {
  const inv = parseHetznerInvoice(SYNTHETIC_SLUG_COLLISION_TEXT);
  assertEquals(inv.perProject.length, 2);
  const slugs = inv.perProject.map((p) => p.slug);
  assertEquals(new Set(slugs).size, 2); // injective
  assertEquals(slugs, ["shrug-core", "shrug-core-2"]);
});

Deno.test("dedupeSlugs: disambiguates blank + duplicate slugs in order", () => {
  const lines = [
    { project: "A", slug: "x", amount: 1 },
    { project: "B", slug: "x", amount: 2 },
    { project: "C", slug: "", amount: 3 },
  ];
  dedupeSlugs(lines);
  assertEquals(lines.map((l) => l.slug), ["x", "x-2", "project"]);
});

Deno.test("parseAmount / normalizeDate / detectCurrency / slugify units", () => {
  assertEquals(parseAmount("1,234.56"), 1234.56);
  assertEquals(parseAmount("12.00 USD"), 12.0);
  assertEquals(parseAmount("nope"), null);
  assertEquals(normalizeDate("10/11/2026"), "2026-11-10");
  assertEquals(normalizeDate("garbage"), null);
  assertEquals(detectCurrency("billed in USD"), "USD");
  assertEquals(detectCurrency("Total: $5.00"), "USD");
  assertEquals(detectCurrency("Total: 5,00 €"), "EUR");
  assertEquals(detectCurrency("no currency here"), null);
  assertEquals(slugify("Acme  Passthrough/Web"), "acme-passthrough-web");
});

// ===========================================================================
// Sources
// ===========================================================================

Deno.test("BytesSource.fromBase64 round-trips bytes", async () => {
  const raw = new Uint8Array([1, 2, 3, 4]);
  const b64 = btoa(String.fromCharCode(...raw));
  const src = BytesSource.fromBase64(b64);
  assertEquals(await src.fetchBytes(), raw);
});

Deno.test("FileSource reads bytes from a path", async () => {
  const tmp = await Deno.makeTempFile();
  const raw = new Uint8Array([9, 8, 7]);
  await Deno.writeFile(tmp, raw);
  try {
    assertEquals(await new FileSource(tmp).fetchBytes(), raw);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("ImapSource is a gated stub until pub-4", async () => {
  await assertRejects(
    () => new ImapSource({ folder: "INBOX", uid: 1 }).fetchBytes(),
    Error,
    "gated on @shrug/imap.fetchAttachment (pub-4)",
  );
});

Deno.test("resolveSource selects by input; throws when none given", () => {
  assertEquals(resolveSource({ bytesBase64: btoa("x") }) instanceof BytesSource, true);
  assertEquals(resolveSource({ filePath: "/x" }) instanceof FileSource, true);
  assertEquals(resolveSource({ imap: { uid: 1 } }) instanceof ImapSource, true);
  assertThrows(() => resolveSource({}), Error, "no source given");
});

// ===========================================================================
// PDF extraction (exercises the REAL pdf.ts over a synthetic PDF end-to-end)
// ===========================================================================

/** Generate a synthetic single-page PDF with the given text lines. */
async function synthPdf(lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let y = 800;
  for (const l of lines) {
    page.drawText(l, { x: 50, y, size: 12, font });
    y -= 20;
  }
  return await doc.save();
}

Deno.test("looksLikePdf: magic header gate", () => {
  assertEquals(looksLikePdf(new TextEncoder().encode("%PDF-1.7\n")), true);
  assertEquals(looksLikePdf(new TextEncoder().encode("<html>")), false);
  assertEquals(looksLikePdf(new Uint8Array([])), false);
});

Deno.test("extractPdfText: rejects a non-PDF payload", async () => {
  await assertRejects(
    () => extractPdfText(new TextEncoder().encode("not a pdf")),
    Error,
    "not a PDF",
  );
});

Deno.test("extractPdfText + parse: end-to-end over a generated synthetic PDF", async () => {
  const bytes = await synthPdf([
    "Invoice no. SYNTH-PDF-01",
    "Invoice date 10/11/2026",
    "Customer ID K0000000000",
    "Period October 2026",
    "Currency USD",
    "Overview",
    "shrug-core-infra 17.50",
    "acme-passthrough-web 42.00",
    "Net total excl. VAT 59.50",
    "Total 59.50",
  ]);
  const text = await extractPdfText(bytes);
  const inv = parseHetznerInvoice(text);
  assertEquals(inv.invoiceNumber, "SYNTH-PDF-01");
  assertEquals(inv.currency, "USD");
  assertEquals(inv.perProject.length, 2);
  assertEquals(inv.total, 59.5);
});

// ===========================================================================
// Candidate layer + USD-only guard (H1)
// ===========================================================================

const CAND_CFG: CandidatesConfig = {
  currencyId: "1",
  vendorId: "vend-hetzner",
  fallbackCategoryId: "cat-fallback",
  projectClientMap: { [PASSTHROUGH_PROJECT]: PASSTHROUGH_CLIENT_ID },
  projectCategoryMap: {
    "acme-passthrough-web": "cat-hosting",
    "shrug-core-infra": "cat-infra",
  },
  expectedCurrency: "USD",
};

function usdInvoices(): HetznerInvoice[] {
  return [parseHetznerInvoice(SYNTHETIC_USD_TEXT)];
}

Deno.test("buildExpenseCandidates: one candidate per project, passthrough carries clientId", () => {
  const { candidates, mapping, preview } = buildExpenseCandidates(
    usdInvoices(),
    CAND_CFG,
  );
  assertEquals(candidates.length, 3); // never a lump
  assertEquals(preview.length, 3);
  const passthrough = candidates.find((c) =>
    c.rawCategory === PASSTHROUGH_PROJECT
  )!;
  const own = candidates.find((c) => c.rawCategory === "shrug-lab-sandbox")!;
  // C1: every candidate sets direction/status so it passes isCandidate.
  for (const c of candidates) {
    assertEquals(c.direction, "debit");
    assertEquals(c.status, "posted");
    assertEquals(c.currency, "USD");
  }
  // Passthrough project carries the mapped clientId; Shrug-own omits it.
  assertEquals(passthrough.clientId, PASSTHROUGH_CLIENT_ID);
  assertEquals("clientId" in own, false);
  // Dedup id shape.
  assertEquals(passthrough.id, "hetzner:SYNTH-2026-0001:acme-passthrough-web");
  // Mapping binds the vendor + per-project categories.
  assertEquals(mapping.vendors?.["Hetzner"], "vend-hetzner");
  assertEquals(mapping.categories?.["acme-passthrough-web"], "cat-hosting");
  assertEquals(mapping.currencyId, "1");
});

Deno.test("buildExpenseCandidates: USD guard THROWS on a non-USD (EUR) invoice (H1)", () => {
  const eur = [parseHetznerInvoice(SYNTHETIC_EUR_TEXT)];
  assertThrows(
    () => buildExpenseCandidates(eur, CAND_CFG),
    Error,
    "not USD",
  );
});

Deno.test("buildExpenseCandidates: USD guard THROWS on a mixed-currency batch (H1/F2)", () => {
  const mixed = [
    parseHetznerInvoice(SYNTHETIC_USD_TEXT),
    parseHetznerInvoice(SYNTHETIC_EUR_TEXT),
  ];
  assertThrows(
    () => buildExpenseCandidates(mixed, CAND_CFG),
    Error,
    "mixed-currency batch",
  );
});

Deno.test("assertSingleExpectedCurrency: fail-closed on undetected currency", () => {
  const unknown = [{ ...parseHetznerInvoice(SYNTHETIC_USD_TEXT), currency: null }];
  assertThrows(() => assertSingleExpectedCurrency(unknown, "USD"), Error);
});

Deno.test("buildExpenseCandidates: rejects a malformed projectClientMap hashid", () => {
  assertThrows(
    () =>
      buildExpenseCandidates(usdInvoices(), {
        ...CAND_CFG,
        projectClientMap: { [PASSTHROUGH_PROJECT]: "../../users/5" },
      }),
    Error,
    "not a valid IN hashid",
  );
});

Deno.test("buildExpenseCandidates: multi-invoice USD batch keeps distinct dedup keys", () => {
  const two = [
    parseHetznerInvoice(SYNTHETIC_USD_TEXT),
    parseHetznerInvoice(SYNTHETIC_USD_TEXT_2),
  ];
  const { candidates } = buildExpenseCandidates(two, CAND_CFG);
  const ids = candidates.map((c) => c.id);
  assertEquals(new Set(ids).size, ids.length);
});

// ===========================================================================
// TENANT WALL — END-TO-END against the REAL extended invoiceninja write path
// ===========================================================================

/** Minimal resolved invoiceninja config (token present; dedup GET served). */
const IN_CFG = {
  baseUrl: "https://clients.example.com/api/v1",
  apiToken: "SEKRIT",
  perPage: 100,
  withTrashed: false,
  dryRun: true,
} as unknown as Parameters<typeof upsertExpense>[0];

interface Rec {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

/** A FetchLike that serves the dedup GET /expenses as an EMPTY page (F3) and
 * captures every POST body, returning a created id. */
function writeFetcher(): { f: FetchLike; posts: Rec[]; calls: Rec[] } {
  const posts: Rec[] = [];
  const calls: Rec[] = [];
  const f: FetchLike = (url, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body
      ? JSON.parse(init.body) as Record<string, unknown>
      : undefined;
    calls.push({ url, method, body });
    if (method === "POST") {
      posts.push({ url, method, body });
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve({ data: { id: "exp-new" } }),
      });
    }
    // Dedup GET: a well-formed EMPTY, single-page result (F3) so the create
    // path is reached.
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () =>
        Promise.resolve({
          data: [],
          meta: { pagination: { current_page: 1, total_pages: 1 } },
        }),
    });
  };
  return { f, posts, calls };
}

Deno.test("tenant wall: passthrough candidate POSTs client_id, action=created (C1+L2)", async () => {
  const { candidates, mapping } = buildExpenseCandidates(usdInvoices(), CAND_CFG);
  const passthrough = candidates.find((c) =>
    c.rawCategory === PASSTHROUGH_PROJECT
  )!;
  const { f, posts } = writeFetcher();
  const r = await upsertExpense(
    IN_CFG,
    passthrough,
    mapping as Mapping,
    false, // dryRun=false: drive the REAL POST path
    f,
    new Set<string>(),
  );
  // Proves direction='debit' + status='posted' satisfy isCandidate (not skipped).
  assertEquals(r.action, "created");
  assertEquals(r.reason, undefined);
  assertEquals(posts.length, 1);
  const body = posts[0].body!;
  // Passthrough client attribution survives into the REAL POST body.
  assertEquals(body.client_id, PASSTHROUGH_CLIENT_ID);
  // Field contract: vendor_id resolved (not null), date from postedDate, dedup
  // key in custom_value1 + transaction_reference, category per project.
  assertEquals(body.vendor_id, "vend-hetzner");
  assertEquals(body.date, "2026-11-10");
  assertEquals(body.custom_value1, "hetzner:SYNTH-2026-0001:acme-passthrough-web");
  assertEquals(body.transaction_reference, body.custom_value1);
  assertEquals(body.category_id, "cat-hosting"); // not the fallback
});

Deno.test("tenant wall: Shrug-own candidate POSTs NO client_id, category per project", async () => {
  const { candidates, mapping } = buildExpenseCandidates(usdInvoices(), CAND_CFG);
  const own = candidates.find((c) => c.rawCategory === "shrug-core-infra")!;
  const { f, posts } = writeFetcher();
  const r = await upsertExpense(IN_CFG, own, mapping as Mapping, false, f, new Set());
  assertEquals(r.action, "created");
  const body = posts[0].body!;
  assertEquals("client_id" in body, false); // opex: no tenant attribution
  assertEquals(body.category_id, "cat-infra");
});

Deno.test("tenant wall: an unmapped Shrug-own project falls back to fallbackCategoryId", async () => {
  const { candidates, mapping } = buildExpenseCandidates(usdInvoices(), CAND_CFG);
  const sandbox = candidates.find((c) => c.rawCategory === "shrug-lab-sandbox")!;
  const { f, posts } = writeFetcher();
  await upsertExpense(IN_CFG, sandbox, mapping as Mapping, false, f, new Set());
  assertEquals(posts[0].body!.category_id, "cat-fallback");
});

Deno.test("tenant wall REGRESSION (C1): a candidate missing direction/status is skipped non-candidate", async () => {
  const { candidates, mapping } = buildExpenseCandidates(usdInvoices(), CAND_CFG);
  const broken = { ...candidates[0] };
  delete broken.direction; // simulate the cycle-2 bug
  const { f, posts } = writeFetcher();
  const r = await upsertExpense(IN_CFG, broken, mapping as Mapping, false, f, new Set());
  assertEquals(r.action, "skip");
  assertEquals(r.reason, "non-candidate");
  assertEquals(posts.length, 0); // nothing written
});

Deno.test("tenant wall (L2): a malformed clientId is rejected, never POSTed", async () => {
  const { candidates, mapping } = buildExpenseCandidates(usdInvoices(), CAND_CFG);
  // Hand-inject a bad clientId past the build-time guard to prove invoiceninja's
  // OWN mapTxnToExpense charset gate rejects it at the write path.
  const bad = { ...candidates[0], clientId: "../../users/5" };
  const { f, posts } = writeFetcher();
  await assertRejects(
    () => upsertExpense(IN_CFG, bad, mapping as Mapping, false, f, new Set()),
    Error,
    "not a valid Invoice Ninja hashid",
  );
  assertEquals(posts.length, 0); // never reached the POST
});

// ===========================================================================
// Model helpers
// ===========================================================================

Deno.test("invoiceResourceName: filesystem-safe slug of the invoice number", () => {
  const inv = parseHetznerInvoice(SYNTHETIC_USD_TEXT);
  assertEquals(invoiceResourceName(inv), "synth-2026-0001");
});

Deno.test("decodeInvoice: coerces an untyped record, drops malformed project rows", () => {
  const inv = decodeInvoice({
    invoiceNumber: "X-1",
    currency: "USD",
    perProject: [
      { project: "a", slug: "a", amount: 1 },
      { project: "b", slug: "b" }, // malformed (no amount) -> dropped
      "garbage",
    ],
    total: 1,
  });
  assertEquals(inv.invoiceNumber, "X-1");
  assertEquals(inv.perProject.length, 1);
  assertEquals(inv.perProject[0].project, "a");
});
