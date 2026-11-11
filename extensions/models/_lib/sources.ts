// ---------------------------------------------------------------------------
// Pluggable invoice-source adapters.
//
// The core parse/model/report/candidate path is SOURCE-AGNOSTIC: it depends only
// on the InvoiceSource interface, never on where the bytes come from. FileSource
// (local path) and BytesSource (inline base64 / raw bytes) ship NOW so the whole
// core is buildable and testable with no IMAP. ImapSource is declared against the
// interface but THROWS a clear "gated on pub-4" error until @shrug/imap ships
// fetchAttachment (decoded attachment bytes for a UID) -- so nothing in the core
// depends on IMAP existing.
// ---------------------------------------------------------------------------

import { decodeBase64 } from "jsr:@std/encoding@1.0.11/base64";

/** A source of raw PDF bytes. The ONLY provenance seam the core depends on. */
export interface InvoiceSource {
  /** Resolve the raw PDF bytes for one invoice. */
  fetchBytes(): Promise<Uint8Array>;
}

/** Raw-bytes / inline-base64 source (used by parseInvoice and, later, IMAP). */
export class BytesSource implements InvoiceSource {
  constructor(private readonly bytes: Uint8Array) {}

  fetchBytes(): Promise<Uint8Array> {
    return Promise.resolve(this.bytes);
  }

  /** Build a {@link BytesSource} from a base64 string (method-input path). */
  static fromBase64(b64: string): BytesSource {
    return new BytesSource(decodeBase64(b64));
  }
}

/** Local-file source (used by ingestFile). */
export class FileSource implements InvoiceSource {
  constructor(private readonly path: string) {}

  async fetchBytes(): Promise<Uint8Array> {
    return await Deno.readFile(this.path);
  }
}

/** The clear error ImapSource throws until pub-4 lands. */
export const IMAP_GATED_MESSAGE =
  "ImapSource: gated on @shrug/imap.fetchAttachment (pub-4) — the attachment-" +
  "bytes method does not exist yet. Use FileSource or BytesSource until pub-4 " +
  "lands and exposes decoded attachment bytes for a UID.";

/**
 * IMAP attachment source — GATED on pub-4. Declared against {@link InvoiceSource}
 * so the core is written against it today, but every call throws until
 * @shrug/imap.fetchAttachment exists. When pub-4 lands, the sync workflow runs
 * @shrug/imap.fetchAttachment and feeds the decoded bytes in via BytesSource;
 * this class is filled in (or retired in favor of BytesSource) at that point.
 */
export class ImapSource implements InvoiceSource {
  constructor(
    private readonly _ref: {
      folder?: string;
      uid?: number;
      filename?: string;
    } = {},
  ) {}

  fetchBytes(): Promise<Uint8Array> {
    // A rejected promise (not a sync throw) so it honors the async interface.
    return Promise.reject(new Error(IMAP_GATED_MESSAGE));
  }
}

/** Method-input descriptor for selecting a source adapter. */
export interface SourceInput {
  /** Inline base64 PDF bytes (BytesSource). */
  bytesBase64?: string;
  /** Local filesystem path (FileSource). */
  filePath?: string;
  /** IMAP attachment reference (ImapSource — gated on pub-4). */
  imap?: { folder?: string; uid?: number; filename?: string };
}

/**
 * Select the source adapter from a method input. Precedence: inline bytes ->
 * file path -> imap (gated). Throws when none is provided.
 */
export function resolveSource(input: SourceInput): InvoiceSource {
  if (input.bytesBase64 !== undefined) {
    return BytesSource.fromBase64(input.bytesBase64);
  }
  if (input.filePath !== undefined) return new FileSource(input.filePath);
  if (input.imap !== undefined) return new ImapSource(input.imap);
  throw new Error(
    "resolveSource: no source given — provide bytesBase64, filePath, or imap " +
      "(imap is gated on pub-4).",
  );
}
