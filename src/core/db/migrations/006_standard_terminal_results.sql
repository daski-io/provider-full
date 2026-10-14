-- The terminal identity every dispatch and lifecycle attestation signs is
-- frozen in the transaction that first makes a standard order's task
-- terminal: state, completion time, the canonical unrevealed task projection
-- (encrypted at rest and bound to its row), its hash, the protected artifact
-- references an authorized artifact read may reveal, and provenance. Later
-- messages, support requests and event retention never change it.
CREATE TABLE public.standard_terminal_results (
    transaction_id text NOT NULL,
    state text NOT NULL,
    completed_at timestamp with time zone NOT NULL,
    result_hash bytea NOT NULL,
    projection_encrypted text,
    protected_references jsonb DEFAULT '[]'::jsonb NOT NULL,
    provenance text NOT NULL,
    evidence_id uuid,
    isolated_diagnostic text,
    frozen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT standard_terminal_results_state_check
        CHECK ((state = ANY (ARRAY['completed'::text, 'failed'::text, 'canceled'::text]))),
    CONSTRAINT standard_terminal_results_result_hash_check CHECK ((octet_length(result_hash) = 32)),
    CONSTRAINT standard_terminal_results_projection_check
        CHECK (((projection_encrypted IS NULL) OR (projection_encrypted ~~ 'daski:v1:%'::text))),
    CONSTRAINT standard_terminal_results_references_check
        CHECK ((jsonb_typeof(protected_references) = 'array'::text)),
    CONSTRAINT standard_terminal_results_provenance_check
        CHECK ((provenance = ANY (ARRAY['terminal-transition'::text, 'verified-attestation'::text,
          'unobserved-reconstruction'::text]))),
    -- Only a verified historical identity may lack its projection bytes.
    CONSTRAINT standard_terminal_results_bytes_check
        CHECK (((projection_encrypted IS NOT NULL) OR (provenance = 'verified-attestation'::text))),
    CONSTRAINT standard_terminal_results_evidence_check
        CHECK (((provenance = 'terminal-transition'::text) = (evidence_id IS NULL))),
    CONSTRAINT standard_terminal_results_isolated_check
        CHECK (((isolated_diagnostic IS NULL) OR (isolated_diagnostic ~ '^[a-z_]{1,64}$'::text)))
);

ALTER TABLE ONLY public.standard_terminal_results
    ADD CONSTRAINT standard_terminal_results_pkey PRIMARY KEY (transaction_id);
ALTER TABLE ONLY public.standard_terminal_results
    ADD CONSTRAINT standard_terminal_results_transaction_id_fkey
    FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);

-- Terminal rows that predate frozen results are reconciled only from
-- recorded evidence: a provider terminal attestation the gateway retained
-- (verified against the terminal attestation key before it is recorded), or
-- an operator's record of the gateway handoff stating that no terminal
-- identity was admitted for the order. Evidence is append-only.
CREATE TABLE public.standard_terminal_evidence (
    id uuid NOT NULL,
    transaction_id text NOT NULL,
    kind text NOT NULL,
    attestation jsonb,
    state text,
    completed_at_seconds bigint,
    result_hash bytea,
    reference text NOT NULL,
    recorded_by text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT standard_terminal_evidence_kind_check
        CHECK ((kind = ANY (ARRAY['attestation'::text, 'unobserved'::text]))),
    CONSTRAINT standard_terminal_evidence_identity_check
        CHECK (((kind = 'attestation'::text) = ((attestation IS NOT NULL) AND (state IS NOT NULL)
          AND (completed_at_seconds IS NOT NULL) AND (result_hash IS NOT NULL)))),
    CONSTRAINT standard_terminal_evidence_unobserved_check
        CHECK (((kind = 'unobserved'::text) = ((attestation IS NULL) AND (state IS NULL)
          AND (completed_at_seconds IS NULL) AND (result_hash IS NULL)))),
    CONSTRAINT standard_terminal_evidence_state_check
        CHECK (((state IS NULL) OR (state = ANY (ARRAY['completed'::text, 'failed'::text, 'canceled'::text])))),
    CONSTRAINT standard_terminal_evidence_hash_check
        CHECK (((result_hash IS NULL) OR (octet_length(result_hash) = 32))),
    CONSTRAINT standard_terminal_evidence_reference_check
        CHECK (((length(reference) >= 1) AND (length(reference) <= 256))),
    CONSTRAINT standard_terminal_evidence_recorded_by_check
        CHECK (((length(recorded_by) >= 1) AND (length(recorded_by) <= 128)))
);

ALTER TABLE ONLY public.standard_terminal_evidence
    ADD CONSTRAINT standard_terminal_evidence_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.standard_terminal_evidence
    ADD CONSTRAINT standard_terminal_evidence_transaction_id_fkey
    FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);
ALTER TABLE ONLY public.standard_terminal_results
    ADD CONSTRAINT standard_terminal_results_evidence_id_fkey
    FOREIGN KEY (evidence_id) REFERENCES public.standard_terminal_evidence(id);

CREATE INDEX standard_terminal_evidence_transaction_idx
    ON public.standard_terminal_evidence USING btree (transaction_id, recorded_at);

-- A frozen identity never changes. Its ciphertext may only be re-encrypted
-- under a newer key (readers verify the hash of what they decrypt), and a
-- conflicting historical identity may isolate it, once, with a diagnostic.
CREATE FUNCTION public.guard_standard_terminal_result() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'standard terminal results are retained'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
    OR NEW.state IS DISTINCT FROM OLD.state
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
    OR NEW.result_hash IS DISTINCT FROM OLD.result_hash
    OR NEW.protected_references IS DISTINCT FROM OLD.protected_references
    OR NEW.provenance IS DISTINCT FROM OLD.provenance
    OR NEW.evidence_id IS DISTINCT FROM OLD.evidence_id
    OR NEW.frozen_at IS DISTINCT FROM OLD.frozen_at
    OR ((OLD.projection_encrypted IS NULL) <> (NEW.projection_encrypted IS NULL))
    OR (OLD.isolated_diagnostic IS NOT NULL
        AND NEW.isolated_diagnostic IS DISTINCT FROM OLD.isolated_diagnostic)
  THEN
    RAISE EXCEPTION 'standard terminal results are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER standard_terminal_results_immutable
    BEFORE DELETE OR UPDATE ON public.standard_terminal_results
    FOR EACH ROW EXECUTE FUNCTION public.guard_standard_terminal_result();

CREATE FUNCTION public.prevent_standard_terminal_evidence_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'standard terminal evidence is append-only'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER standard_terminal_evidence_append_only
    BEFORE DELETE OR UPDATE ON public.standard_terminal_evidence
    FOR EACH ROW EXECUTE FUNCTION public.prevent_standard_terminal_evidence_change();
