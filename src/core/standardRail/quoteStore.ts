import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import type { SupplierCostCeiling } from "../serviceRegistry/types.js";
import { canonicalHash } from "./canonical.js";

/** The seven fields the provider signs and the gateway hashes as providerQuoteHash. */
export interface ProviderQuotePayload {
  outcomeId: string;
  listingManifestHash: Hex;
  requestHash: Hex;
  grossAmount: string;
  payer: Hex | null;
  issuedAt: number;
  validBefore: number;
}

export interface StoredProviderQuote extends ProviderQuotePayload {
  quoteHash: Hex;
  pricingMode: "fixed" | "dynamic";
  /** Raw stored JSON; callers parse it strictly before trusting it. */
  supplierCostCeiling: unknown;
}

interface QuoteRow {
  quote_hash: Buffer;
  outcome_id: string;
  listing_manifest_hash: Buffer;
  request_hash: Buffer;
  gross_amount: string;
  payer: string | null;
  pricing_mode: "fixed" | "dynamic";
  supplier_cost_ceiling: unknown;
  issued_at: Date;
  valid_before: Date;
}

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");
const hex = (value: Buffer): Hex => `0x${value.toString("hex")}`;
const seconds = (value: Date): number => Math.floor(value.getTime() / 1_000);

export function providerQuoteHash(payload: ProviderQuotePayload): Hex {
  return canonicalHash(payload);
}

function fromRow(row: QuoteRow): StoredProviderQuote {
  return {
    quoteHash: hex(row.quote_hash),
    outcomeId: row.outcome_id,
    listingManifestHash: hex(row.listing_manifest_hash),
    requestHash: hex(row.request_hash),
    grossAmount: row.gross_amount,
    payer: row.payer as Hex | null,
    issuedAt: seconds(row.issued_at),
    validBefore: seconds(row.valid_before),
    pricingMode: row.pricing_mode,
    supplierCostCeiling: row.supplier_cost_ceiling,
  };
}

/**
 * Persist the readiness quote before it is signed, so a later dispatch can
 * verify its payer, request, listing, price and time bindings. An identical
 * payload (same second) reuses the row only when every binding agrees.
 */
export async function persistProviderQuote(
  payload: ProviderQuotePayload,
  binding: { pricingMode: "fixed" | "dynamic"; supplierCostCeiling: SupplierCostCeiling | null },
): Promise<Hex> {
  const quoteHash = providerQuoteHash(payload);
  const inserted = await pool.query(
    `INSERT INTO standard_provider_quotes
      (quote_hash,outcome_id,listing_manifest_hash,request_hash,gross_amount,
       supplier_cost_ceiling,issued_at,valid_before,payer,pricing_mode)
     VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7),to_timestamp($8),$9,$10)
     ON CONFLICT (quote_hash) DO NOTHING`,
    [
      bytes(quoteHash), payload.outcomeId, bytes(payload.listingManifestHash),
      bytes(payload.requestHash), payload.grossAmount,
      binding.supplierCostCeiling ? JSON.stringify(binding.supplierCostCeiling) : null,
      payload.issuedAt, payload.validBefore, payload.payer, binding.pricingMode,
    ],
  );
  if (inserted.rowCount === 1) return quoteHash;
  const existing = await loadProviderQuote(quoteHash);
  if (
    !existing || existing.pricingMode !== binding.pricingMode ||
    canonicalHash(existing.supplierCostCeiling ?? null) !== canonicalHash(binding.supplierCostCeiling)
  ) throw new Error("A provider quote with the same hash carries different bindings");
  return quoteHash;
}

export async function loadProviderQuote(quoteHash: Hex): Promise<StoredProviderQuote | null> {
  const result = await pool.query<QuoteRow>(
    `SELECT quote_hash,outcome_id,listing_manifest_hash,request_hash,gross_amount::text AS gross_amount,
            payer,pricing_mode,supplier_cost_ceiling,issued_at,valid_before
       FROM standard_provider_quotes WHERE quote_hash=$1`,
    [bytes(quoteHash)],
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}
