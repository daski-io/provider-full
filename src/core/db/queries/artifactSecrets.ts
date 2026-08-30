import { pool } from "../pool.js";

// Generic encrypted-at-rest show-once artifact fields. Generalizes the
// transfer_artifacts pattern: a skill persists its artifact with a
// redacted placeholder at the secret's field path, writes the real value
// here (AES-256-GCM envelope via core/chain/encryption.ts), and
// responseBuilder consumes the decrypted value into the first assembled
// buyer response while the row is inside its validity window.
// After expiry the buyer permanently sees the redacted placeholder —
// recovery goes through whatever wallet-authorized rotation skill the service offers.
//
// `revealed_count` is a one-way consumption marker. Subsequent task reads
// keep the persisted redacted placeholder.

export interface ArtifactSecretRow {
  id: string;
  transaction_id: string;
  artifact_name: string;
  field_path: string;
  secret: string;
  expires_at: Date;
  revealed_count: number;
  created_at: Date;
}

export async function createArtifactSecret(args: {
  transaction_id: string;
  artifact_name: string;
  /** Dot-path into the artifact's data payload, e.g. "credentials.password". */
  field_path: string;
  /** Base64 AES-256-GCM envelope of the cleartext value. */
  secret_encrypted: string;
  expires_at: Date;
}): Promise<ArtifactSecretRow> {
  const result = await pool.query(
    `INSERT INTO artifact_secrets
       (transaction_id, artifact_name, field_path, secret, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (transaction_id, artifact_name, field_path) DO UPDATE
       SET secret = EXCLUDED.secret,
           expires_at = EXCLUDED.expires_at
     RETURNING *`,
    [
      args.transaction_id,
      args.artifact_name,
      args.field_path,
      args.secret_encrypted,
      args.expires_at,
    ],
  );
  return result.rows[0] as ArtifactSecretRow;
}

/// Read one secret's ciphertext WITHOUT bumping the reveal counter —
/// recovery paths (a provisioning retry re-asserting the journaled
/// password at the supplier) read here; buyer-facing reveals go through
/// consumeArtifactSecrets.
export async function getArtifactSecret(
  transactionId: string,
  artifactName: string,
  fieldPath: string,
): Promise<string | null> {
  const result = await pool.query<{ secret: string }>(
    `SELECT secret FROM artifact_secrets
      WHERE transaction_id = $1 AND artifact_name = $2 AND field_path = $3
        AND expires_at > now()`,
    [transactionId, artifactName, fieldPath],
  );
  return result.rows[0]?.secret ?? null;
}

export async function getArtifactSecretExpiry(
  transactionId: string,
  artifactName: string,
  fieldPath: string,
): Promise<Date | null> {
  const result = await pool.query<{ expires_at: Date }>(
    `SELECT expires_at FROM artifact_secrets
      WHERE transaction_id = $1 AND artifact_name = $2 AND field_path = $3`,
    [transactionId, artifactName, fieldPath],
  );
  return result.rows[0]?.expires_at ?? null;
}

/// Atomically consume every unexpired, unrevealed secret attached to an
/// artifact. Concurrent and later responses receive an empty array.
export async function consumeArtifactSecrets(
  transactionId: string,
  artifactName: string,
): Promise<Array<{ field_path: string; secret: string }>> {
  const result = await pool.query(
    `UPDATE artifact_secrets
        SET revealed_count = 1
      WHERE transaction_id = $1 AND artifact_name = $2
        AND expires_at > now() AND revealed_count = 0
      RETURNING field_path, secret`,
    [transactionId, artifactName],
  );
  return result.rows as Array<{ field_path: string; secret: string }>;
}

/// Read every unexpired secret attached to an artifact without consuming it.
/// The standard rail uses this only after the gateway has verified the payer's
/// fresh, action-scoped authorization. Repeatable reads make transport retries
/// deterministic while expiry still bounds the disclosure window.
export async function readArtifactSecrets(
  transactionId: string,
  artifactName: string,
): Promise<Array<{ field_path: string; secret: string }>> {
  const result = await pool.query(
    `SELECT field_path, secret
       FROM artifact_secrets
      WHERE transaction_id = $1 AND artifact_name = $2
        AND expires_at > now()
      ORDER BY field_path`,
    [transactionId, artifactName],
  );
  return result.rows as Array<{ field_path: string; secret: string }>;
}

/// Housekeeping: hard-delete expired rows. Called opportunistically by
/// service lifecycle workers; keeping ciphertext around past its validity
/// window serves no purpose.
export async function purgeExpiredArtifactSecrets(): Promise<number> {
  const result = await pool.query(
    `DELETE FROM artifact_secrets WHERE expires_at <= now()`,
  );
  return result.rowCount ?? 0;
}
