# @shrug/hetzner-invoice

Turn Hetzner invoice PDFs into structured per-project spend data, surface it as a
finops cost report, and emit per-project Invoice Ninja expense candidates written
through the already-gated `@shrug/invoiceninja.upsertExpenses` money-write.

## What it does

1. **Parse** a Hetzner invoice PDF into a typed struct (`invoices` resource):
   invoice number, customer id, date, billing period, detected ISO currency,
   per-project subtotals, and net/VAT/total figures. No OCR -- Hetzner invoices
   carry a real text layer, extracted with a bundled pure-JS library.
2. **Report** Hetzner spend broken out BY PROJECT over time
   (`@shrug/hetzner-invoice/hetzner-spend`), read-only. Passthrough-client
   projects stay visible and separate from Shrug-own projects.
3. **Emit** one BankTxn-shaped expense candidate PER PROJECT (never a lump) plus
   the Mapping, for `@shrug/invoiceninja.upsertExpenses` to write.

## Source-agnostic ingest

The core depends only on an `InvoiceSource` adapter:

- `FileSource` -- a local PDF path (`ingestFile`, or `parseInvoice` with
  `filePath`).
- `BytesSource` -- inline base64 bytes (`parseInvoice` with `bytesBase64`).
- `ImapSource` -- GATED on pub-4 (`@shrug/imap.fetchAttachment`). It throws a
  clear error until that method lands; the file-sourced path is the
  independently-shippable baseline.

## USD-only expense sync

Expense sync is **USD-only**. Invoice Ninja's `isCandidate` gate silently drops
any non-USD row, so `buildExpenseCandidates` runs a pre-write guard that THROWS
loudly on:

- any detected non-USD currency, and
- a mixed-currency batch.

Run backfills **per currency**. A single EUR invoice in an otherwise-USD batch
makes the whole batch throw (by design -- nothing is silently dropped); separate
the currencies and re-run. Non-USD invoices are still visible as spend in the
`hetzner-spend` report; only their expense sync is out of scope until Invoice
Ninja's `isCandidate` is extended to non-USD.

## Tenant attribution

`projectClientMap` (project label OR slug -> Invoice Ninja client hashid) marks a
project as a passthrough (re-billed) line: its candidate carries `clientId`, so
the `@shrug/invoiceninja` `mapTxnToExpense` passthrough writes `client_id`.
Projects not in the map are Shrug-own opex and carry no `clientId`.

## Writes

This model NEVER POSTs. The single audited money-write is
`@shrug/invoiceninja.upsertExpenses` (dryRun default true); a live expense POST
needs that model's explicit `dryRun=false` plus a per-action sign-off. This model
emits pure candidates plus a dry-run preview only.

## Dependency

The expense-sync path depends on `@shrug/invoiceninja` >= 2026.11.10.1, which
adds the per-txn `client_id` passthrough (with hashid validation) to
`mapTxnToExpense`. Parse + report work with no such dependency.
