# @shrug/hetzner-invoice

Turn Hetzner invoice PDFs into structured per-project spend data, surface it as a
finops cost report, and emit per-project Invoice Ninja expense candidates written
through the already-gated `@shrug/invoiceninja.upsertExpenses` money-write.

## Overview

A Hetzner invoice is a single PDF whose Overview table breaks the bill out by
project. This extension parses that PDF into a typed record, aggregates spend by
project (and by currency) for finops, and shapes one Invoice Ninja expense
candidate PER PROJECT -- so a passthrough-client project stays a distinct,
re-billable line and never gets merged into a lump sum. It is the parse + model +
report + candidate half of the pipeline; the actual expense POST is delegated to
the existing audited `@shrug/invoiceninja.upsertExpenses` write.

No OCR is involved: Hetzner invoices carry a real text layer, extracted with a
bundled pure-JS library (`unpdf`), so the extension runs on an empty
`platforms: []` (universal) and shells out to no host binary.

## Methods and report

- `parseInvoice` -- parse PDF bytes (inline base64 `bytesBase64`, a `filePath`,
  or a resolved source) into the `invoices` resource: invoice number, customer
  id, date, billing period, detected ISO currency, per-project subtotals, and
  net/VAT/total figures.
- `ingestFile` -- parse a local PDF (`FileSource`) into the `invoices` resource;
  defaults to `globalArguments.defaultFilePath` when no `filePath` is given.
- `buildExpenseCandidates` -- build ONE BankTxn-shaped candidate PER PROJECT
  (never a lump) plus the Mapping, from parsed invoice(s) passed via CEL or, when
  none is passed, from the model's OWN latest `invoices` resources. Writes the
  `expenseCandidates` resource; NEVER POSTs.
- `@shrug/hetzner-invoice/hetzner-spend` -- a read-only, model-scope report:
  Hetzner spend broken out by project over time (per-project subtotal, invoice
  total, detected ISO currency). Non-USD invoices stay visible here even though
  they are not expense-synced.

## Source-adapter model

The core depends only on an `InvoiceSource` adapter, never on where the bytes
come from:

- `FileSource` -- a local PDF path (`ingestFile`, or `parseInvoice` with
  `filePath`).
- `BytesSource` -- inline base64 bytes (`parseInvoice` with `bytesBase64`).
- `ImapSource` -- GATED on pub-4 (`@shrug/imap.fetchAttachment`). It is declared
  against the interface but every call throws a clear "gated on pub-4" error
  until that method lands; the file/bytes path is the independently-shippable
  baseline. When pub-4 ships, the workflow runs `@shrug/imap.fetchAttachment` and
  feeds the decoded bytes in through `BytesSource`.

## Usage example

Ingest a local Hetzner PDF, build per-project expense candidates, and run the
gated Invoice Ninja sync dry-run first. Values below are synthetic.

```bash
# 1. Create the behavior. projectClientMap marks a project as a passthrough
#    (re-billed) line -- "acme-passthrough-web" carries a synthetic IN client
#    hashid; the two shrug-own projects are plain opex (no clientId).
swamp behavior create hetzner-nov @shrug/hetzner-invoice \
  --set expectedCurrency=USD \
  --set currencyId=1 \
  --set vendorId=Vq1a2b3 \
  --set 'projectClientMap={"acme-passthrough-web":"Wpmbk5e"}'

# 2. Parse a local invoice PDF (FileSource) into the `invoices` resource.
swamp behavior run hetzner-nov ingestFile \
  --set filePath=/srv/invoices/synth-2026-0001.pdf

# 3. Build one expense candidate per project. With no `invoices` arg it reads the
#    model's own latest `invoices` resources. USD-only guard runs FIRST.
swamp behavior run hetzner-nov buildExpenseCandidates

# 4. Inspect the dry-run preview (one line per project, with clientId/categoryId).
swamp behavior get hetzner-nov --json

# 5. Read the per-project spend report (read-only aggregation).
swamp report get @shrug/hetzner-invoice/hetzner-spend --model hetzner-nov --json
```

Then hand the emitted candidates + mapping to the single audited money-write.
`upsertExpenses` is itself dryRun default true, so this previews only; a live
POST needs that model's explicit `dryRun=false` plus a per-action sign-off:

```bash
# Dry-run the real expense POST (previews, writes nothing).
swamp behavior run invoiceninja upsertExpenses \
  --set 'candidates=${{ data.latest("hetzner-nov", "candidates").attributes.candidates }}' \
  --set 'mapping=${{ data.latest("hetzner-nov", "candidates").attributes.mapping }}'
```

## USD-only expense sync

Expense sync is USD-only. Invoice Ninja's `isCandidate` gate silently drops any
non-USD row, so `buildExpenseCandidates` runs a pre-write guard that THROWS
loudly on:

- any detected non-USD currency (a null/undetected currency is a violation too
  -- fail closed), and
- a mixed-currency batch.

Run backfills PER CURRENCY. A single EUR invoice in an otherwise-USD batch makes
the whole batch throw (by design -- nothing is silently dropped); separate the
currencies and re-run. Non-USD invoices are still visible as spend in the
`hetzner-spend` report; only their expense sync is out of scope until Invoice
Ninja's `isCandidate` is extended to non-USD.

## Tenant attribution

`projectClientMap` (project label OR slug -> Invoice Ninja client hashid) marks a
project as a passthrough (re-billed) line: its candidate carries `clientId`, so
the `@shrug/invoiceninja` `mapTxnToExpense` passthrough writes `client_id`.
Projects not in the map are Shrug-own opex and carry no `clientId`. A
`projectClientMap` value that is not a valid IN hashid is rejected loudly.

## Writes

This model NEVER POSTs. The single audited money-write is
`@shrug/invoiceninja.upsertExpenses` (dryRun default true); a live expense POST
needs that model's explicit `dryRun=false` plus a per-action sign-off. This model
emits pure candidates plus a dry-run preview only.

## Dependency

The expense-sync path depends on `@shrug/invoiceninja` >= 2026.11.10.1, which
adds the per-txn `client_id` passthrough (with hashid validation) to
`mapTxnToExpense`. Parse + report work with no such dependency.

## Testing

Logic is pure and fully unit-testable with no network and no real PDFs. The
parser, amount/currency helpers, source adapters, USD-only guard, and candidate
builder are exercised against SYNTHETIC, depersonalized fixtures only (invented
invoice numbers, customer ids, and project labels -- never a real invoice).

```bash
# Run the extension test suite under the pinned Deno runtime.
~/.swamp/deno/deno test -A

# Check published-quality factors (README, symbol docs, deps, license).
swamp extension quality manifest.yaml --json
```
