// Tests for the hetzner-spend report. SYNTHETIC fixtures only.

import { assertEquals } from "jsr:@std/assert@1";
import { parseHetznerInvoice } from "../models/_lib/parse.ts";
import {
  SYNTHETIC_EUR_TEXT,
  SYNTHETIC_USD_TEXT,
} from "../models/_fixtures/synthetic_invoice_text.ts";
import { aggregateSpend, asInvoiceSnap, renderMarkdown } from "./hetzner-spend.ts";

Deno.test("asInvoiceSnap: accepts an invoice record, rejects the candidates record", () => {
  const inv = parseHetznerInvoice(SYNTHETIC_USD_TEXT);
  const bytes = new TextEncoder().encode(
    JSON.stringify({ ...inv, retrievedAt: "2026-11-10T00:00:00Z" }),
  );
  const snap = asInvoiceSnap(bytes);
  assertEquals(snap?.invoiceNumber, "SYNTH-2026-0001");
  // The expenseCandidates resource shape is NOT an invoice.
  assertEquals(
    asInvoiceSnap(
      new TextEncoder().encode(JSON.stringify({ candidates: [], mapping: {} })),
    ),
    null,
  );
  assertEquals(asInvoiceSnap(new TextEncoder().encode("not json")), null);
  assertEquals(asInvoiceSnap(null), null);
});

Deno.test("aggregateSpend: per-project + per-currency totals keep currencies disjoint", () => {
  const usd = parseHetznerInvoice(SYNTHETIC_USD_TEXT);
  const eur = parseHetznerInvoice(SYNTHETIC_EUR_TEXT);
  const agg = aggregateSpend([
    { ...usd, total: usd.total },
    { ...eur, total: eur.total },
  ]);
  assertEquals(agg.byCurrency["USD"], 64.5);
  assertEquals(agg.byCurrency["EUR"], 17.5);
  // EUR spend is VISIBLE even though it is never expense-synced (H1).
  const eurRow = agg.byProject.find((p) => p.currency === "EUR");
  assertEquals(eurRow?.total, 17.5);
});

Deno.test("renderMarkdown: empty + populated paths", () => {
  assertEquals(
    renderMarkdown(aggregateSpend([])).includes("No parsed Hetzner invoices"),
    true,
  );
  const md = renderMarkdown(aggregateSpend([parseHetznerInvoice(SYNTHETIC_USD_TEXT)]));
  assertEquals(md.includes("acme-passthrough-web"), true);
  assertEquals(md.includes("## By project"), true);
});
