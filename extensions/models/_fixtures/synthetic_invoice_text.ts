// ---------------------------------------------------------------------------
// SYNTHETIC, DEPERSONALIZED fixtures ONLY.
//
// Every value here is invented. NONE of it is copied, derived, or transcribed
// from any real Hetzner invoice PDF (which would carry a real name/address,
// Customer ID, IBAN/BIC, VAT registration, and real client project names). These
// fixtures reproduce the STRUCTURAL text anchors only -- the shapes the parser
// keys on -- with fake values. Do not replace any of these with real data.
// ---------------------------------------------------------------------------

/**
 * A synthetic Hetzner-shaped extracted text layer, denominated in USD, with an
 * Overview table of three projects -- one of which (`acme-passthrough-web`) is a
 * synthetic passthrough-client project and two of which are Shrug-own.
 */
export const SYNTHETIC_USD_TEXT = [
  "Hetzner Online GmbH",
  "Invoice no. SYNTH-2026-0001",
  "Invoice date 10/11/2026",
  "Customer ID K0000000000",
  "Period October 2026",
  "Currency USD",
  "",
  "Overview",
  "acme-passthrough-web 42.00",
  "shrug-core-infra 17.50",
  "shrug-lab-sandbox 5.00",
  "",
  "Net total excl. VAT 64.50",
  "VAT 0.00",
  "Total 64.50",
].join("\n");

/** A second synthetic USD invoice (distinct number) for multi-invoice tests. */
export const SYNTHETIC_USD_TEXT_2 = [
  "Hetzner Online GmbH",
  "Invoice no. SYNTH-2026-0002",
  "Invoice date 10/12/2026",
  "Customer ID K0000000000",
  "Period November 2026",
  "Currency USD",
  "",
  "Overview",
  "acme-passthrough-web 42.00",
  "shrug-core-infra 20.00",
  "",
  "Net total excl. VAT 62.00",
  "VAT 0.00",
  "Total 62.00",
].join("\n");

/** A synthetic EUR invoice -- used to prove the USD-only guard throws (H1). */
export const SYNTHETIC_EUR_TEXT = [
  "Hetzner Online GmbH",
  "Invoice no. SYNTH-2026-0003",
  "Invoice date 10/11/2026",
  "Customer ID K0000000000",
  "Period October 2026",
  "Currency EUR",
  "",
  "Overview",
  "shrug-core-infra 17,50",
  "",
  "Net total excl. VAT 17,50",
  "VAT 0,00",
  "Total 17,50",
].join("\n");

/**
 * A synthetic invoice whose Overview has TWO rows that slugify to the same base
 * -- proves slug disambiguation keeps N distinct dedup keys for N rows (F5).
 */
export const SYNTHETIC_SLUG_COLLISION_TEXT = [
  "Invoice no. SYNTH-2026-0009",
  "Invoice date 10/11/2026",
  "Customer ID K0000000000",
  "Currency USD",
  "",
  "Overview",
  "Shrug Core 10.00",
  "shrug-core 20.00",
  "",
  "Net total excl. VAT 30.00",
  "Total 30.00",
].join("\n");

/** The synthetic passthrough-client project label present in the USD fixtures. */
export const PASSTHROUGH_PROJECT = "acme-passthrough-web";
/** A synthetic IN client hashid (valid charset) for the passthrough project. */
export const PASSTHROUGH_CLIENT_ID = "Wpmbk5e";
