// ---------------------------------------------------------------------------
// Source-agnostic PDF text-extraction wrapper.
//
// Takes raw PDF bytes (Uint8Array) and returns the extracted text layer. Hetzner
// invoices are machine-generated and carry a real text layer, so there is NO OCR
// here. This module knows nothing about byte provenance (file / inline bytes /
// IMAP attachment), so it is fully testable with no source adapter.
//
// The pinned extractor is `unpdf` (a serverless-friendly repackaging of pdf.js
// with the worker/node-canvas paths disabled) so it survives swamp's bundler and
// runs on an empty `platforms: []` extension. The exact pin is recorded in
// deno.lock (repo rule 7) and proven under the BUNDLED runtime by the F5 gate
// (`swamp extension quality` + a `swamp behavior run ... parseInvoice` smoke),
// not just by `deno test` (which exercises this module directly, NOT the bundle).
// ---------------------------------------------------------------------------

import { extractText, getDocumentProxy } from "npm:unpdf@0.12.1";

/** PDF magic header (`%PDF-`) — every well-formed PDF starts with these bytes. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // % P D F -

/**
 * Whether `bytes` begins with the `%PDF-` magic header. A defensive pre-flight
 * (F5 bundle-runtime validation): a non-PDF payload (an HTML error page, a
 * truncated download, a wrong attachment) is rejected with a clear message
 * BEFORE it reaches the extractor, which would otherwise crash opaquely deep
 * inside the bundled pdf.js. Exported for unit testing.
 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i++) {
    if (bytes[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Extract the text layer from PDF `bytes`, newline-joined across pages.
 *
 * `extractText(pdf)` (NO `mergePages`) returns a per-page string array that
 * PRESERVES intra-page line breaks (`\n`); joining pages with `\n` keeps the
 * line structure the anchor parser keys on. `mergePages:true` would collapse
 * every line to a single space-joined blob and is deliberately NOT used.
 *
 * @throws if `bytes` is not a PDF (fails the `%PDF-` magic check).
 */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  if (!looksLikePdf(bytes)) {
    throw new Error(
      "extractPdfText: payload is not a PDF (missing %PDF- magic header) — " +
        "refusing to hand a non-PDF to the extractor.",
    );
  }
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf);
  const pages = Array.isArray(text) ? text : [text];
  return pages.join("\n");
}
