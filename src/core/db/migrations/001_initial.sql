-- Fresh-schema baseline for the generic Daski provider starter.
-- The repository was unreleased when its inherited migration chain was collapsed.
-- Once published, add new checksummed migrations; never edit this file.

SET check_function_bodies = false;

CREATE SCHEMA IF NOT EXISTS public;

CREATE FUNCTION public.prevent_escalation_evidence_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  purging BOOLEAN;
  retry_reset BOOLEAN;
  rotation_run TEXT;
BEGIN
  rotation_run := NULLIF(current_setting('daski.protected_data_rotation_run', true), '');
  IF rotation_run IS NOT NULL
    AND EXISTS (SELECT 1 FROM protected_data_rotation_roles WHERE role_name = current_user)
    AND EXISTS (
      SELECT 1 FROM protected_data_rotation_runs
       WHERE id = rotation_run::uuid AND status = 'running'
    )
  THEN
    RETURN NEW;
  END IF;
  purging := OLD.evidence_purged_at IS NULL
    AND NEW.evidence_purged_at IS NOT NULL
    AND OLD.status IN ('approved','edited','rejected')
    AND NEW.status = OLD.status
    AND NEW.execution_snapshot_encrypted IS NULL
    AND NEW.reviewer_edits_encrypted IS NULL
    AND NEW.review_binding_encrypted IS NULL
    AND NEW.adapter_result_encrypted IS NULL;
  retry_reset := OLD.source = 'fulfillment_hold'
    AND OLD.status IN ('resolution_executing','resolution_result_ready')
    AND NEW.status IN ('pending','resolution_queued')
    AND OLD.fulfillment_attempt_seq < 9223372036854775807
    AND NEW.fulfillment_attempt_seq = OLD.fulfillment_attempt_seq + 1
    AND NEW.transaction_id IS NOT DISTINCT FROM OLD.transaction_id
    AND NEW.resolved_at IS NOT DISTINCT FROM OLD.resolved_at
    AND NEW.resolved_by IS NOT DISTINCT FROM OLD.resolved_by
    AND NEW.adapter_result_encrypted IS NULL
    AND NEW.adapter_result_hash IS NULL
    AND NEW.resolution_started_at IS NULL
    AND NEW.resolution_error IS NULL
    AND (
      (
        NEW.status = 'pending'
        AND NEW.reviewer_decision IS NULL
        AND NEW.reviewer_actor IS NULL
        AND NEW.reviewer_edits_encrypted IS NULL
        AND NEW.reviewer_edits_hash IS NULL
        AND NEW.review_binding_encrypted IS NULL
        AND NEW.review_binding_hash IS NULL
        AND NEW.resolution_claimed_at IS NULL
      ) OR (
        NEW.status = 'resolution_queued'
        AND NEW.reviewer_decision IS NOT DISTINCT FROM OLD.reviewer_decision
        AND NEW.reviewer_actor IS NOT DISTINCT FROM OLD.reviewer_actor
        AND NEW.reviewer_edits_encrypted IS NOT DISTINCT FROM OLD.reviewer_edits_encrypted
        AND NEW.reviewer_edits_hash IS NOT DISTINCT FROM OLD.reviewer_edits_hash
        AND NEW.review_binding_encrypted IS NOT DISTINCT FROM OLD.review_binding_encrypted
        AND NEW.review_binding_hash IS NOT DISTINCT FROM OLD.review_binding_hash
        AND NEW.resolution_claimed_at IS NOT DISTINCT FROM OLD.resolution_claimed_at
      )
    )
    AND EXISTS (
      SELECT 1 FROM fulfillment_hold_attempts a
       WHERE a.escalation_id = OLD.id
         AND a.attempt_seq = NEW.fulfillment_attempt_seq
         AND a.snapshot_service_id IS NOT DISTINCT FROM OLD.snapshot_service_id
         AND a.prior_status = OLD.status
         AND a.next_status = NEW.status
         AND a.fulfillment_supplier IS NOT DISTINCT FROM OLD.fulfillment_supplier
         AND a.fulfillment_hold_kind IS NOT DISTINCT FROM OLD.fulfillment_hold_kind
         AND a.fulfillment_attempts IS NOT DISTINCT FROM OLD.fulfillment_attempts
         AND a.reviewer_decision IS NOT DISTINCT FROM OLD.reviewer_decision
         AND a.reviewer_actor IS NOT DISTINCT FROM OLD.reviewer_actor
         AND (a.reviewer_edits_encrypted IS NULL) = (OLD.reviewer_edits_encrypted IS NULL)
         AND a.reviewer_edits_hash IS NOT DISTINCT FROM OLD.reviewer_edits_hash
         AND (a.review_binding_encrypted IS NULL) = (OLD.review_binding_encrypted IS NULL)
         AND a.review_binding_hash IS NOT DISTINCT FROM OLD.review_binding_hash
         AND (a.adapter_result_encrypted IS NULL) = (OLD.adapter_result_encrypted IS NULL)
         AND a.adapter_result_hash IS NOT DISTINCT FROM OLD.adapter_result_hash
         AND a.resolution_claimed_at IS NOT DISTINCT FROM OLD.resolution_claimed_at
         AND a.resolution_started_at IS NOT DISTINCT FROM OLD.resolution_started_at
         AND (a.resolution_error IS NULL) = (OLD.resolution_error IS NULL)
    );
  IF NEW.fulfillment_attempt_seq IS DISTINCT FROM OLD.fulfillment_attempt_seq
    AND NOT retry_reset
  THEN
    RAISE EXCEPTION 'fulfillment hold attempt sequence requires exact archived evidence';
  END IF;
  IF purging AND (
    NEW.execution_snapshot_hash IS DISTINCT FROM OLD.execution_snapshot_hash OR
    NEW.request_hash IS DISTINCT FROM OLD.request_hash OR
    NEW.snapshot_version IS DISTINCT FROM OLD.snapshot_version OR
    NEW.snapshot_service_id IS DISTINCT FROM OLD.snapshot_service_id OR
    NEW.snapshot_skill_id IS DISTINCT FROM OLD.snapshot_skill_id OR
    NEW.snapshot_asset_id IS DISTINCT FROM OLD.snapshot_asset_id OR
    NEW.reviewer_decision IS DISTINCT FROM OLD.reviewer_decision OR
    NEW.reviewer_actor IS DISTINCT FROM OLD.reviewer_actor OR
    NEW.reviewer_edits_hash IS DISTINCT FROM OLD.reviewer_edits_hash OR
    NEW.review_binding_hash IS DISTINCT FROM OLD.review_binding_hash OR
    NEW.adapter_result_hash IS DISTINCT FROM OLD.adapter_result_hash
  ) THEN
    RAISE EXCEPTION 'escalation evidence purge cannot alter retained bindings';
  END IF;
  IF NOT purging AND OLD.execution_snapshot_encrypted IS NOT NULL AND (
    NEW.execution_snapshot_encrypted IS DISTINCT FROM OLD.execution_snapshot_encrypted OR
    NEW.execution_snapshot_hash IS DISTINCT FROM OLD.execution_snapshot_hash OR
    NEW.request_hash IS DISTINCT FROM OLD.request_hash OR
    NEW.snapshot_version IS DISTINCT FROM OLD.snapshot_version OR
    NEW.snapshot_service_id IS DISTINCT FROM OLD.snapshot_service_id OR
    NEW.snapshot_skill_id IS DISTINCT FROM OLD.snapshot_skill_id OR
    NEW.snapshot_asset_id IS DISTINCT FROM OLD.snapshot_asset_id
  ) THEN
    RAISE EXCEPTION 'escalation execution snapshot is immutable';
  END IF;
  IF NOT purging AND NOT retry_reset AND OLD.reviewer_decision IS NOT NULL AND (
    NEW.reviewer_decision IS DISTINCT FROM OLD.reviewer_decision OR
    NEW.reviewer_actor IS DISTINCT FROM OLD.reviewer_actor OR
    NEW.reviewer_edits_encrypted IS DISTINCT FROM OLD.reviewer_edits_encrypted OR
    NEW.reviewer_edits_hash IS DISTINCT FROM OLD.reviewer_edits_hash OR
    NEW.review_binding_encrypted IS DISTINCT FROM OLD.review_binding_encrypted OR
    NEW.review_binding_hash IS DISTINCT FROM OLD.review_binding_hash
  ) THEN
    RAISE EXCEPTION 'escalation review authorization is immutable';
  END IF;
  IF NOT purging AND NOT retry_reset AND OLD.adapter_result_encrypted IS NOT NULL AND (
    NEW.adapter_result_encrypted IS DISTINCT FROM OLD.adapter_result_encrypted OR
    NEW.adapter_result_hash IS DISTINCT FROM OLD.adapter_result_hash
  ) THEN
    RAISE EXCEPTION 'escalation adapter result is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.prevent_fulfillment_hold_attempt_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  current_hold escalations%ROWTYPE;
  rotation_run TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO current_hold FROM escalations
     WHERE id = NEW.escalation_id FOR UPDATE;
    IF NOT FOUND
      OR current_hold.source <> 'fulfillment_hold'
      OR current_hold.status NOT IN ('resolution_executing','resolution_result_ready')
      OR current_hold.fulfillment_attempt_seq >= 9223372036854775807
      OR NEW.attempt_seq <> current_hold.fulfillment_attempt_seq + 1
      OR NEW.snapshot_service_id IS DISTINCT FROM current_hold.snapshot_service_id
      OR NEW.prior_status <> current_hold.status
      OR NEW.fulfillment_supplier IS DISTINCT FROM current_hold.fulfillment_supplier
      OR NEW.fulfillment_hold_kind IS DISTINCT FROM current_hold.fulfillment_hold_kind
      OR NEW.fulfillment_attempts IS DISTINCT FROM current_hold.fulfillment_attempts
      OR NEW.reviewer_decision IS DISTINCT FROM current_hold.reviewer_decision
      OR NEW.reviewer_actor IS DISTINCT FROM current_hold.reviewer_actor
      OR NEW.reviewer_edits_encrypted IS DISTINCT FROM current_hold.reviewer_edits_encrypted
      OR NEW.reviewer_edits_hash IS DISTINCT FROM current_hold.reviewer_edits_hash
      OR NEW.review_binding_encrypted IS DISTINCT FROM current_hold.review_binding_encrypted
      OR NEW.review_binding_hash IS DISTINCT FROM current_hold.review_binding_hash
      OR NEW.adapter_result_encrypted IS DISTINCT FROM current_hold.adapter_result_encrypted
      OR NEW.adapter_result_hash IS DISTINCT FROM current_hold.adapter_result_hash
      OR NEW.resolution_claimed_at IS DISTINCT FROM current_hold.resolution_claimed_at
      OR NEW.resolution_started_at IS DISTINCT FROM current_hold.resolution_started_at
      OR NEW.resolution_error IS DISTINCT FROM current_hold.resolution_error
      OR NEW.evidence_purged_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'fulfillment hold attempt must exactly archive the locked live evidence';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fulfillment hold attempt evidence is append-only';
  END IF;

  rotation_run := NULLIF(current_setting('daski.protected_data_rotation_run', true), '');
  IF rotation_run IS NOT NULL
    AND EXISTS (SELECT 1 FROM protected_data_rotation_roles WHERE role_name = current_user)
    AND EXISTS (
      SELECT 1 FROM protected_data_rotation_runs
       WHERE id = rotation_run::uuid AND status = 'running'
    )
  THEN
    IF (
      to_jsonb(NEW) - ARRAY[
        'reviewer_edits_encrypted','review_binding_encrypted',
        'adapter_result_encrypted','resolution_error'
      ]::text[]
    ) = (
      to_jsonb(OLD) - ARRAY[
        'reviewer_edits_encrypted','review_binding_encrypted',
        'adapter_result_encrypted','resolution_error'
      ]::text[]
    )
      AND (OLD.reviewer_edits_encrypted IS NULL) = (NEW.reviewer_edits_encrypted IS NULL)
      AND (OLD.review_binding_encrypted IS NULL) = (NEW.review_binding_encrypted IS NULL)
      AND (OLD.adapter_result_encrypted IS NULL) = (NEW.adapter_result_encrypted IS NULL)
      AND (OLD.resolution_error IS NULL) = (NEW.resolution_error IS NULL)
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'protected-data rotation may only replace archived ciphertext';
  END IF;

  IF OLD.evidence_purged_at IS NULL
    AND NEW.evidence_purged_at IS NOT NULL
    AND NEW.reviewer_edits_encrypted IS NULL
    AND NEW.review_binding_encrypted IS NULL
    AND NEW.adapter_result_encrypted IS NULL
    AND NEW.resolution_error IS NULL
    AND (
      to_jsonb(NEW) - ARRAY[
        'reviewer_edits_encrypted','review_binding_encrypted',
        'adapter_result_encrypted','resolution_error','evidence_purged_at'
      ]::text[]
    ) = (
      to_jsonb(OLD) - ARRAY[
        'reviewer_edits_encrypted','review_binding_encrypted',
        'adapter_result_encrypted','resolution_error','evidence_purged_at'
      ]::text[]
    )
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'fulfillment hold attempt evidence is append-only';
END;
$$;

CREATE FUNCTION public.reject_compliance_governance_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND current_setting('daski.protected_data_rotation_run', true) IS NOT NULL
    AND EXISTS (SELECT 1 FROM protected_data_rotation_roles WHERE role_name = current_user)
    AND EXISTS (
      SELECT 1 FROM protected_data_rotation_runs
       WHERE id = current_setting('daski.protected_data_rotation_run', true)::uuid
         AND status = 'running'
    )
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'compliance governance approvals are append-only';
END;
$$;

CREATE TABLE public.compliance_cases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    screening_check_id uuid NOT NULL,
    transaction_id text,
    asset_id uuid,
    status text DEFAULT 'confirmed'::text NOT NULL,
    rules_version text NOT NULL,
    confirmed_by text NOT NULL,
    confirmed_at timestamp with time zone DEFAULT now() NOT NULL,
    counsel_due_at timestamp with time zone NOT NULL,
    counsel_contacted_at timestamp with time zone,
    counsel_alerted_at timestamp with time zone,
    report_due_at timestamp with time zone NOT NULL,
    report_submitted_at timestamp with time zone,
    report_alerted_at timestamp with time zone,
    funds_segregated_at timestamp with time zone,
    blocked_funds_address text NOT NULL,
    evidence text NOT NULL,
    closed_at timestamp with time zone,
    closed_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT compliance_cases_evidence_check CHECK ((evidence ~~ 'daski:v1:%'::text)),
    CONSTRAINT compliance_cases_status_check CHECK ((status = ANY (ARRAY['confirmed'::text, 'counsel_contacted'::text, 'funds_segregated'::text, 'report_submitted'::text, 'ready_to_close'::text, 'closed'::text])))
);

CREATE TABLE public.legal_holds (
    id uuid NOT NULL,
    scope_type text NOT NULL,
    scope_id text NOT NULL,
    reason text NOT NULL,
    placed_by text NOT NULL,
    placed_at timestamp with time zone DEFAULT now() NOT NULL,
    released_by text,
    released_at timestamp with time zone,
    CONSTRAINT legal_holds_reason_check CHECK ((reason ~~ 'daski:v1:%'::text)),
    CONSTRAINT legal_holds_scope_id_check CHECK (((length(scope_id) >= 1) AND (length(scope_id) <= 256))),
    CONSTRAINT legal_holds_scope_type_check CHECK ((scope_type = ANY (ARRAY['transaction'::text, 'asset'::text, 'compliance_case'::text]))),
    CONSTRAINT legal_holds_uuid_scope_check CHECK (((scope_type = 'transaction'::text) OR (scope_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)))
);

CREATE VIEW public.active_legal_hold_targets AS
 SELECT legal_holds.id AS hold_id,
        CASE
            WHEN (legal_holds.scope_type = 'transaction'::text) THEN legal_holds.scope_id
            ELSE NULL::text
        END AS transaction_id,
        CASE
            WHEN (legal_holds.scope_type = 'asset'::text) THEN (legal_holds.scope_id)::uuid
            ELSE NULL::uuid
        END AS asset_id
   FROM public.legal_holds
  WHERE ((legal_holds.released_at IS NULL) AND (legal_holds.scope_type = ANY (ARRAY['transaction'::text, 'asset'::text])))
UNION ALL
 SELECT h.id AS hold_id,
    c.transaction_id,
    c.asset_id
   FROM (public.legal_holds h
     JOIN public.compliance_cases c ON (((h.scope_type = 'compliance_case'::text) AND (h.scope_id = (c.id)::text))))
  WHERE (h.released_at IS NULL);

CREATE TABLE public.artifact_secrets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_id text NOT NULL,
    artifact_name text NOT NULL,
    field_path text NOT NULL,
    secret text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revealed_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    service_id uuid NOT NULL,
    type text NOT NULL,
    identifier text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    identifier_hash text NOT NULL,
    CONSTRAINT assets_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'expired'::text, 'transferred_out'::text, 'deleted'::text])))
);

CREATE TABLE public.auth_rate_limit_buckets (
    key_hash bytea NOT NULL,
    window_start timestamp with time zone NOT NULL,
    request_count integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT auth_rate_key_hash_length CHECK ((octet_length(key_hash) = 32)),
    CONSTRAINT auth_rate_positive_count CHECK ((request_count > 0))
);

CREATE TABLE public.blocked_identities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    wallet_address text,
    reason text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_at timestamp with time zone,
    removed_by text,
    CONSTRAINT blocked_identities_wallet_required CHECK ((wallet_address IS NOT NULL))
);

CREATE TABLE public.chat_threads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    wallet_address text,
    escalation_id uuid,
    title text,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chat_threads_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'rejected'::text]))),
    CONSTRAINT chat_threads_title_envelope_check CHECK (((title IS NULL) OR (title ~~ 'daski:v1:%'::text)))
);

CREATE TABLE public.compliance_governance_approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    environment text NOT NULL,
    chain_id integer NOT NULL,
    rules_version text NOT NULL,
    country_mapping_version text NOT NULL,
    calibration_artifact_hash text NOT NULL,
    approver text NOT NULL,
    approved_at timestamp with time zone NOT NULL,
    evidence_reference text NOT NULL,
    evidence_reference_hash text NOT NULL,
    blocked_funds_address text NOT NULL,
    blocked_funds_ownership_evidence text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    policy_version text DEFAULT 'legacy'::text NOT NULL,
    policy_hash text DEFAULT 'legacy'::text NOT NULL,
    policy_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    scope_risk_acceptance text,
    CONSTRAINT compliance_governance_approv_blocked_funds_ownership_evid_check CHECK ((blocked_funds_ownership_evidence ~~ 'daski:v1:%'::text)),
    CONSTRAINT compliance_governance_approvals_approver_check CHECK ((approver ~~ 'daski:v1:%'::text)),
    CONSTRAINT compliance_governance_approvals_evidence_reference_check CHECK ((evidence_reference ~~ 'daski:v1:%'::text)),
    CONSTRAINT compliance_governance_approvals_scope_risk_acceptance_check CHECK (((scope_risk_acceptance IS NULL) OR (scope_risk_acceptance ~~ 'daski:v1:%'::text)))
);

CREATE TABLE public.compliance_sweep_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    trigger text NOT NULL,
    list_version text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    next_due_at timestamp with time zone NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    parties_count integer,
    holds_count integer,
    error text,
    CONSTRAINT compliance_sweep_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])))
);

CREATE TABLE public.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    wallet_address text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_known_email text,
    last_known_email_hash text,
    CONSTRAINT customers_wallet_canonical CHECK ((wallet_address = lower(wallet_address))),
    CONSTRAINT customers_wallet_shape CHECK ((wallet_address ~ '^0x[0-9a-f]{40}$'::text))
);

CREATE TABLE public.durable_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    queue text NOT NULL,
    idempotency_key text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 12 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    lease_token uuid,
    dead_letter_surfaced_at timestamp with time zone,
    CONSTRAINT durable_jobs_attempts_check CHECK (((attempts >= 0) AND (max_attempts > 0))),
    CONSTRAINT durable_jobs_lease_shape_check CHECK ((((status = 'running'::text) AND (lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR ((status <> 'running'::text) AND (lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_expires_at IS NULL)))),
    CONSTRAINT durable_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'retry'::text, 'dead_letter'::text, 'completed'::text])))
);

CREATE TABLE public.emails_inbound (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id text NOT NULL,
    from_address text NOT NULL,
    to_address text NOT NULL,
    subject text,
    body_text text,
    body_html text,
    headers jsonb,
    in_reply_to text,
    thread_root text,
    service_id uuid,
    transaction_id text,
    classification text,
    classification_reason text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    rfc_message_id text,
    thread_root_hash text,
    processing_mode text,
    processing_service_slug text,
    processing_status text DEFAULT 'queued'::text NOT NULL,
    processing_attempts integer DEFAULT 0 NOT NULL,
    processing_available_at timestamp with time zone DEFAULT now() NOT NULL,
    processing_lease_owner text,
    processing_lease_expires_at timestamp with time zone,
    processing_error text,
    to_address_hash text,
    processed_at timestamp with time zone,
    legal_hold boolean DEFAULT false NOT NULL,
    customer_id uuid,
    CONSTRAINT emails_inbound_classification_reason_envelope_check CHECK (((classification_reason IS NULL) OR (classification_reason ~~ 'daski:v1:%'::text))),
    CONSTRAINT emails_inbound_from_envelope_check CHECK ((from_address ~~ 'daski:v1:%'::text)),
    CONSTRAINT emails_inbound_headers_envelope_check CHECK (((headers IS NULL) OR ((jsonb_typeof(headers) = 'string'::text) AND ((headers #>> '{}'::text[]) ~~ 'daski:v1:%'::text)))),
    CONSTRAINT emails_inbound_html_envelope_check CHECK (((body_html IS NULL) OR (body_html ~~ 'daski:v1:%'::text))),
    CONSTRAINT emails_inbound_processing_error_envelope_check CHECK (((processing_error IS NULL) OR (processing_error ~~ 'daski:v1:%'::text))),
    CONSTRAINT emails_inbound_processing_mode_check CHECK (((processing_mode IS NULL) OR (processing_mode = ANY (ARRAY['email-agent'::text, 'interceptor'::text])))),
    CONSTRAINT emails_inbound_processing_status_check CHECK ((processing_status = ANY (ARRAY['queued'::text, 'running'::text, 'retry'::text, 'completed'::text, 'dead_letter'::text]))),
    CONSTRAINT emails_inbound_reply_envelope_check CHECK (((in_reply_to IS NULL) OR (in_reply_to ~~ 'daski:v1:%'::text))),
    CONSTRAINT emails_inbound_rfc_envelope_check CHECK (((rfc_message_id IS NULL) OR (rfc_message_id ~~ 'daski:v1:%'::text))),
    CONSTRAINT emails_inbound_subject_envelope_check CHECK (((subject IS NULL) OR (subject ~~ 'daski:v1:%'::text))),
    CONSTRAINT emails_inbound_text_envelope_check CHECK (((body_text IS NULL) OR (body_text ~~ 'daski:v1:%'::text))),
    CONSTRAINT emails_inbound_thread_envelope_check CHECK (((thread_root IS NULL) OR (thread_root ~~ 'daski:v1:%'::text))),
    CONSTRAINT emails_inbound_to_envelope_check CHECK ((to_address ~~ 'daski:v1:%'::text))
);

CREATE TABLE public.emails_outbound (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id text,
    from_address text NOT NULL,
    to_address text NOT NULL,
    subject text,
    body_text text,
    body_html text,
    in_reply_to text,
    thread_root text,
    service_id uuid,
    transaction_id text,
    inbound_id uuid,
    sent_by text NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    delivery_status text,
    delivery_payload jsonb,
    thread_root_hash text,
    legal_hold boolean DEFAULT false NOT NULL,
    idempotency_key text,
    customer_id uuid,
    CONSTRAINT emails_outbound_html_envelope_check CHECK (((body_html IS NULL) OR (body_html ~~ 'daski:v1:%'::text))),
    CONSTRAINT emails_outbound_reply_envelope_check CHECK (((in_reply_to IS NULL) OR (in_reply_to ~~ 'daski:v1:%'::text))),
    CONSTRAINT emails_outbound_sent_by_check CHECK ((sent_by = ANY (ARRAY['email_agent'::text, 'operator_agent'::text, 'admin'::text, 'system'::text]))),
    CONSTRAINT emails_outbound_subject_envelope_check CHECK (((subject IS NULL) OR (subject ~~ 'daski:v1:%'::text))),
    CONSTRAINT emails_outbound_text_envelope_check CHECK (((body_text IS NULL) OR (body_text ~~ 'daski:v1:%'::text))),
    CONSTRAINT emails_outbound_thread_envelope_check CHECK (((thread_root IS NULL) OR (thread_root ~~ 'daski:v1:%'::text))),
    CONSTRAINT emails_outbound_to_envelope_check CHECK ((to_address ~~ 'daski:v1:%'::text))
);

CREATE TABLE public.escalations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_id text,
    question text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    response text,
    edited_data jsonb,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by text,
    assignee text,
    agent_recommendation text,
    inbound_id uuid,
    thread_id uuid,
    execution_snapshot_encrypted text,
    execution_snapshot_hash text,
    request_hash text,
    snapshot_version integer,
    snapshot_service_id uuid,
    snapshot_skill_id text,
    snapshot_asset_id uuid,
    reviewer_decision text,
    reviewer_actor text,
    reviewer_edits_encrypted text,
    reviewer_edits_hash text,
    review_binding_encrypted text,
    review_binding_hash text,
    resolution_job_id uuid,
    resolution_claimed_at timestamp with time zone,
    resolution_started_at timestamp with time zone,
    adapter_result_encrypted text,
    adapter_result_hash text,
    resolution_error text,
    evidence_purged_at timestamp with time zone,
    operator_dispatch_job_id uuid,
    legal_hold boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    fulfillment_supplier text,
    fulfillment_hold_kind text,
    fulfillment_resume_at timestamp with time zone,
    fulfillment_attempts integer,
    fulfillment_attempt_seq bigint DEFAULT 0 NOT NULL,
    review_kind text,
    severity text DEFAULT 'warning'::text NOT NULL,
    dedupe_key text,
    target_type text,
    target_id text,
    why_human text,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    available_actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    review_due_at timestamp with time zone,
    occurrence_count integer DEFAULT 1 NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT escalations_binding_envelope_check CHECK (((review_binding_encrypted IS NULL) OR (review_binding_encrypted ~~ 'daski:v1:%'::text))),
    CONSTRAINT escalations_edits_envelope_check CHECK (((reviewer_edits_encrypted IS NULL) OR (reviewer_edits_encrypted ~~ 'daski:v1:%'::text))),
    CONSTRAINT escalations_fulfillment_attempt_seq_check CHECK (((fulfillment_attempt_seq >= 0) AND ((source = 'fulfillment_hold'::text) OR (fulfillment_attempt_seq = 0)))),
    CONSTRAINT escalations_fulfillment_attempts_check CHECK (((fulfillment_attempts IS NULL) OR (fulfillment_attempts >= 0))),
    CONSTRAINT escalations_fulfillment_hold_kind_check CHECK (((fulfillment_hold_kind IS NULL) OR (fulfillment_hold_kind = ANY (ARRAY['outage'::text, 'provider_config'::text, 'ambiguous'::text])))),
    CONSTRAINT escalations_legacy_edited_data_empty_check CHECK ((edited_data IS NULL)),
    CONSTRAINT escalations_occurrence_count_check CHECK ((occurrence_count > 0)),
    CONSTRAINT escalations_open_reviews_typed CHECK (((status <> ALL (ARRAY['pending'::text, 'in_agent_review'::text, 'awaiting_human'::text, 'resolution_queued'::text, 'rejection_queued'::text, 'resolution_executing'::text, 'resolution_result_ready'::text, 'resolution_attention'::text])) OR ((review_kind IS NOT NULL) AND (dedupe_key IS NOT NULL) AND (target_type IS NOT NULL) AND (target_id IS NOT NULL) AND (why_human IS NOT NULL) AND (evidence ? 'version'::text) AND (review_due_at IS NOT NULL)))),
    CONSTRAINT escalations_protected_snapshot_check CHECK (((source <> ALL (ARRAY['pre_execute'::text, 'fulfillment_hold'::text])) OR ((execution_snapshot_hash IS NOT NULL) AND (request_hash IS NOT NULL) AND (snapshot_version = 1) AND (snapshot_service_id IS NOT NULL) AND (snapshot_skill_id IS NOT NULL) AND ((execution_snapshot_encrypted IS NOT NULL) OR ((evidence_purged_at IS NOT NULL) AND (execution_snapshot_encrypted IS NULL)))))),
    CONSTRAINT escalations_question_envelope_check CHECK ((question ~~ 'daski:v1:%'::text)),
    CONSTRAINT escalations_recommendation_envelope_check CHECK (((agent_recommendation IS NULL) OR (agent_recommendation ~~ 'daski:v1:%'::text))),
    CONSTRAINT escalations_resolution_error_envelope_check CHECK (((resolution_error IS NULL) OR (resolution_error ~~ 'daski:v1:%'::text))),
    CONSTRAINT escalations_response_envelope_check CHECK (((response IS NULL) OR (response ~~ 'daski:v1:%'::text))),
    CONSTRAINT escalations_result_envelope_check CHECK (((adapter_result_encrypted IS NULL) OR (adapter_result_encrypted ~~ 'daski:v1:%'::text))),
    CONSTRAINT escalations_review_decision_check CHECK (((reviewer_decision IS NULL) OR (reviewer_decision = ANY (ARRAY['approved'::text, 'edited'::text, 'rejected'::text])))),
    CONSTRAINT escalations_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text]))),
    CONSTRAINT escalations_snapshot_envelope_check CHECK (((execution_snapshot_encrypted IS NULL) OR (execution_snapshot_encrypted ~~ 'daski:v1:%'::text))),
    CONSTRAINT escalations_source_check CHECK ((source = ANY (ARRAY['pre_execute'::text, 'email_agent'::text, 'operator'::text, 'auto'::text, 'fulfillment_hold'::text, 'screening'::text]))),
    CONSTRAINT escalations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_agent_review'::text, 'awaiting_human'::text, 'resolved'::text, 'rejected'::text, 'approved'::text, 'edited'::text, 'resolution_queued'::text, 'rejection_queued'::text, 'resolution_executing'::text, 'resolution_result_ready'::text, 'resolution_attention'::text])))
);

CREATE TABLE public.events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_id text,
    asset_id uuid,
    service_id uuid,
    source text NOT NULL,
    severity text DEFAULT 'info'::text NOT NULL,
    type text NOT NULL,
    message text NOT NULL,
    payload jsonb,
    actor text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    legal_hold boolean DEFAULT false NOT NULL,
    CONSTRAINT events_severity_check CHECK ((severity = ANY (ARRAY['debug'::text, 'info'::text, 'warn'::text, 'error'::text]))),
    CONSTRAINT events_source_check CHECK ((source = ANY (ARRAY['adapter'::text, 'email'::text, 'llm'::text, 'chain'::text, 'admin'::text, 'push'::text, 'system'::text])))
);

CREATE TABLE public.fulfillment_hold_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    escalation_id uuid NOT NULL,
    attempt_seq bigint NOT NULL,
    snapshot_service_id uuid NOT NULL,
    prior_status text NOT NULL,
    next_status text NOT NULL,
    fulfillment_supplier text,
    fulfillment_hold_kind text,
    fulfillment_attempts integer,
    reviewer_decision text,
    reviewer_actor text,
    reviewer_edits_encrypted text,
    reviewer_edits_hash text,
    review_binding_encrypted text,
    review_binding_hash text,
    adapter_result_encrypted text,
    adapter_result_hash text,
    resolution_claimed_at timestamp with time zone,
    resolution_started_at timestamp with time zone,
    resolution_error text,
    archived_at timestamp with time zone DEFAULT now() NOT NULL,
    evidence_purged_at timestamp with time zone,
    CONSTRAINT fulfillment_hold_attempts_adapter_result_encrypted_check CHECK (((adapter_result_encrypted IS NULL) OR (adapter_result_encrypted ~~ 'daski:v1:%'::text))),
    CONSTRAINT fulfillment_hold_attempts_attempt_seq_check CHECK ((attempt_seq > 0)),
    CONSTRAINT fulfillment_hold_attempts_check CHECK (((evidence_purged_at IS NULL) OR ((reviewer_edits_encrypted IS NULL) AND (review_binding_encrypted IS NULL) AND (adapter_result_encrypted IS NULL) AND (resolution_error IS NULL)))),
    CONSTRAINT fulfillment_hold_attempts_fulfillment_attempts_check CHECK (((fulfillment_attempts IS NULL) OR (fulfillment_attempts >= 0))),
    CONSTRAINT fulfillment_hold_attempts_next_status_check CHECK ((next_status = ANY (ARRAY['pending'::text, 'resolution_queued'::text]))),
    CONSTRAINT fulfillment_hold_attempts_prior_status_check CHECK ((prior_status = ANY (ARRAY['resolution_executing'::text, 'resolution_result_ready'::text]))),
    CONSTRAINT fulfillment_hold_attempts_resolution_error_check CHECK (((resolution_error IS NULL) OR (resolution_error ~~ 'daski:v1:%'::text))),
    CONSTRAINT fulfillment_hold_attempts_review_binding_encrypted_check CHECK (((review_binding_encrypted IS NULL) OR (review_binding_encrypted ~~ 'daski:v1:%'::text))),
    CONSTRAINT fulfillment_hold_attempts_reviewer_decision_check CHECK (((reviewer_decision IS NULL) OR (reviewer_decision = ANY (ARRAY['approved'::text, 'edited'::text])))),
    CONSTRAINT fulfillment_hold_attempts_reviewer_edits_encrypted_check CHECK (((reviewer_edits_encrypted IS NULL) OR (reviewer_edits_encrypted ~~ 'daski:v1:%'::text)))
);

CREATE TABLE public.operator_chats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    wallet_address text NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    tool_calls jsonb,
    tool_call_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    thread_id uuid,
    suggested_actions jsonb,
    legal_hold boolean DEFAULT false NOT NULL,
    CONSTRAINT operator_chat_actions_envelope_check CHECK (((suggested_actions IS NULL) OR ((jsonb_typeof(suggested_actions) = 'string'::text) AND ((suggested_actions #>> '{}'::text[]) ~~ 'daski:v1:%'::text)))),
    CONSTRAINT operator_chat_content_envelope_check CHECK ((content ~~ 'daski:v1:%'::text)),
    CONSTRAINT operator_chat_tools_envelope_check CHECK (((tool_calls IS NULL) OR ((jsonb_typeof(tool_calls) = 'string'::text) AND ((tool_calls #>> '{}'::text[]) ~~ 'daski:v1:%'::text)))),
    CONSTRAINT operator_chats_role_check CHECK ((role = ANY (ARRAY['operator'::text, 'agent'::text, 'tool'::text])))
);

CREATE TABLE public.operator_config_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    resource_type text NOT NULL,
    resource_key text NOT NULL,
    revision bigint NOT NULL,
    actor text NOT NULL,
    changed_fields text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.operator_confirmation_intents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash bytea,
    operator_wallet text NOT NULL,
    session_id uuid,
    thread_id uuid NOT NULL,
    origin_turn_id uuid,
    action_name text NOT NULL,
    arguments_hash bytea NOT NULL,
    target_type text NOT NULL,
    target_id text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    approved_at timestamp with time zone,
    approved_by text,
    approved_session_id uuid,
    consumed_at timestamp with time zone,
    consumed_turn_id uuid,
    voided_at timestamp with time zone,
    pending_payload_encrypted text,
    execution_status text DEFAULT 'not_started'::text NOT NULL,
    execution_started_at timestamp with time zone,
    execution_finished_at timestamp with time zone,
    execution_error_code text,
    execution_error_summary text,
    payload_purged_at timestamp with time zone,
    CONSTRAINT operator_confirmation_execution_error_summary_length CHECK (((execution_error_summary IS NULL) OR (length(execution_error_summary) <= 512))),
    CONSTRAINT operator_confirmation_intents_execution_status_check CHECK ((execution_status = ANY (ARRAY['not_started'::text, 'executing'::text, 'succeeded'::text, 'failed'::text, 'outcome_unknown'::text]))),
    CONSTRAINT operator_confirmation_live_payload_encrypted CHECK (((pending_payload_encrypted IS NOT NULL) OR (voided_at IS NOT NULL) OR (consumed_at IS NOT NULL))),
    CONSTRAINT operator_intent_action_length CHECK (((length(action_name) >= 1) AND (length(action_name) <= 128))),
    CONSTRAINT operator_intent_args_hash_length CHECK ((octet_length(arguments_hash) = 32)),
    CONSTRAINT operator_intent_expiry_order CHECK ((expires_at > issued_at)),
    CONSTRAINT operator_intent_target_id_length CHECK (((length(target_id) >= 1) AND (length(target_id) <= 256))),
    CONSTRAINT operator_intent_target_type_length CHECK (((length(target_type) >= 1) AND (length(target_type) <= 64))),
    CONSTRAINT operator_intent_token_hash_length CHECK ((octet_length(token_hash) = 32))
);

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_id text NOT NULL,
    service_ref bytea NOT NULL,
    onchain_payment_id numeric(78,0) NOT NULL,
    transaction_hash text,
    amount numeric(78,0) NOT NULL,
    currency text DEFAULT 'USDC'::text NOT NULL,
    token_address text,
    status text NOT NULL,
    buyer_agent_id numeric(78,0),
    provider_agent_id numeric(78,0),
    onchain_service_id bytea,
    provider_amount numeric(78,0),
    commission numeric(78,0),
    paid_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    chain_id integer,
    router_address text,
    block_number numeric(78,0),
    block_hash text,
    log_index integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payments_agent_ids_uint256 CHECK ((((buyer_agent_id IS NULL) OR ((buyer_agent_id >= (0)::numeric) AND (buyer_agent_id <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric))) AND ((provider_agent_id IS NULL) OR ((provider_agent_id >= (0)::numeric) AND (provider_agent_id <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric))))),
    CONSTRAINT payments_amount_uint256_signed CHECK (((amount >= '-115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric) AND (amount <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric))),
    CONSTRAINT payments_breakdown_uint256 CHECK ((((provider_amount IS NULL) OR ((provider_amount >= (0)::numeric) AND (provider_amount <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric))) AND ((commission IS NULL) OR ((commission >= (0)::numeric) AND (commission <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric))))),
    CONSTRAINT payments_payment_id_uint256 CHECK (((onchain_payment_id >= (0)::numeric) AND (onchain_payment_id <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric))),
    CONSTRAINT payments_status_check CHECK ((status = ANY (ARRAY['verified'::text, 'disputed'::text, 'proposed'::text, 'reserved'::text, 'approval_broadcast'::text, 'broadcast'::text, 'pending_confirmation'::text, 'reconciliation_required'::text, 'compliance_hold'::text, 'issued'::text, 'failed'::text, 'rejected'::text])))
);

CREATE TABLE public.protected_data_rotation_progress (
    run_id uuid NOT NULL,
    sink text NOT NULL,
    last_record_id text,
    rows_rotated bigint DEFAULT 0 NOT NULL,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.protected_data_rotation_roles (
    role_name name NOT NULL
);

CREATE TABLE public.protected_data_rotation_runs (
    id uuid NOT NULL,
    from_key_id text NOT NULL,
    to_key_id text NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    last_error text,
    CONSTRAINT protected_data_rotation_distinct_keys CHECK ((from_key_id <> to_key_id)),
    CONSTRAINT protected_data_rotation_status_check CHECK ((status = ANY (ARRAY['running'::text, 'failed'::text, 'completed'::text, 'rolled_back'::text])))
);

CREATE TABLE public.provider_chain_writes (
    id uuid NOT NULL,
    chain_id bigint NOT NULL,
    wallet_address text NOT NULL,
    nonce bigint NOT NULL,
    purpose text NOT NULL,
    target_type text NOT NULL,
    target_id text NOT NULL,
    intent_hash text NOT NULL,
    transaction_hash text NOT NULL,
    signed_tx_encrypted text,
    status text NOT NULL,
    supersedes_write_id uuid,
    replacement_write_id uuid,
    fee_bump_count integer DEFAULT 0 NOT NULL,
    broadcast_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    signed_tx_purged_at timestamp with time zone,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_chain_writes_chain_id_check CHECK ((chain_id > 0)),
    CONSTRAINT provider_chain_writes_fee_bump_count_check CHECK ((fee_bump_count >= 0)),
    CONSTRAINT provider_chain_writes_intent_hash_check CHECK ((intent_hash ~ '^0x[0-9a-f]{64}$'::text)),
    CONSTRAINT provider_chain_writes_nonce_check CHECK ((nonce >= 0)),
    CONSTRAINT provider_chain_writes_purpose_check CHECK ((purpose = ANY (ARRAY['reputation_attestation'::text, 'refund_approval'::text, 'refund'::text, 'service_registration'::text, 'service_uri_update'::text, 'nonce_cancel'::text, 'standard_reputation_outcome'::text]))),
    CONSTRAINT provider_chain_writes_signed_tx_encrypted_check CHECK (((signed_tx_encrypted IS NULL) OR (signed_tx_encrypted ~~ 'daski:v1:%'::text))),
    CONSTRAINT provider_chain_writes_status_check CHECK ((status = ANY (ARRAY['prepared'::text, 'broadcast'::text, 'confirmed'::text, 'reverted'::text, 'replaced'::text, 'attention'::text]))),
    CONSTRAINT provider_chain_writes_target_id_check CHECK (((length(target_id) >= 1) AND (length(target_id) <= 256))),
    CONSTRAINT provider_chain_writes_target_type_check CHECK (((length(target_type) >= 1) AND (length(target_type) <= 64))),
    CONSTRAINT provider_chain_writes_transaction_hash_check CHECK ((transaction_hash ~ '^0x[0-9a-f]{64}$'::text)),
    CONSTRAINT provider_chain_writes_wallet_address_check CHECK (((wallet_address = lower(wallet_address)) AND (wallet_address ~ '^0x[0-9a-f]{40}$'::text)))
);

CREATE TABLE public.provider_quotes (
    id uuid NOT NULL,
    service_ref bytea NOT NULL,
    service_id uuid NOT NULL,
    skill_id text NOT NULL,
    canonical_args_hash bytea NOT NULL,
    amount numeric(78,0) NOT NULL,
    token_address text NOT NULL,
    chain_id integer NOT NULL,
    quote_version text NOT NULL,
    signed_payload jsonb NOT NULL,
    provider_signature text NOT NULL,
    signer_address text NOT NULL,
    signing_key_id text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    observation_id uuid,
    trusted_request_country_encrypted text,
    CONSTRAINT provider_quotes_amount_positive CHECK (((amount >= (1)::numeric) AND (amount <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric))),
    CONSTRAINT provider_quotes_expiry CHECK ((expires_at > issued_at))
);

CREATE TABLE public.provider_signer_cursors (
    chain_id bigint NOT NULL,
    wallet_address text NOT NULL,
    next_nonce bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_signer_cursors_chain_id_check CHECK ((chain_id > 0)),
    CONSTRAINT provider_signer_cursors_next_nonce_check CHECK ((next_nonce >= 0)),
    CONSTRAINT provider_signer_cursors_wallet_address_check CHECK (((wallet_address = lower(wallet_address)) AND (wallet_address ~ '^0x[0-9a-f]{40}$'::text)))
);

CREATE TABLE public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_id text NOT NULL,
    url text NOT NULL,
    token text,
    auth_schemes jsonb,
    last_attempt_at timestamp with time zone,
    last_status integer,
    last_error text,
    delivery_count integer DEFAULT 0 NOT NULL,
    failure_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT push_token_envelope_check CHECK (((token IS NULL) OR (token ~~ 'daski:v1:%'::text)))
);

CREATE TABLE public.rate_limit_buckets (
    bucket_key text NOT NULL,
    tokens double precision NOT NULL,
    last_refill timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE public.reputation_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_id text NOT NULL,
    payment_id uuid NOT NULL,
    outcome integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attestation_uid bytea,
    transaction_hash text,
    attempts integer DEFAULT 0 NOT NULL,
    last_attempt_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    nonce bigint,
    signed_tx text,
    receipt_checks integer DEFAULT 0 NOT NULL,
    superseded_outcome integer,
    post_attest_outcome integer,
    provider_write_id uuid,
    prepare_failures integer DEFAULT 0 NOT NULL,
    requeue_count integer DEFAULT 0 NOT NULL,
    next_action_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reputation_submissions_prepare_failures_check CHECK ((prepare_failures >= 0)),
    CONSTRAINT reputation_submissions_requeue_count_check CHECK ((requeue_count >= 0)),
    CONSTRAINT reputation_submissions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'submitted'::text, 'reconciliation_required'::text, 'confirmed'::text, 'failed'::text])))
);

CREATE TABLE public.service_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    service_id uuid NOT NULL,
    skill_id text,
    scope text DEFAULT 'all'::text NOT NULL,
    rule text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    active boolean DEFAULT true NOT NULL,
    CONSTRAINT service_rules_scope_check CHECK ((scope = ANY (ARRAY['all'::text, 'email_agent'::text, 'pre_execute'::text])))
);

CREATE TABLE public.services (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    version text DEFAULT '1'::text NOT NULL,
    category_family text NOT NULL,
    service_type text NOT NULL,
    jurisdictions jsonb NOT NULL,
    turnaround_estimate text,
    service_lifecycle text DEFAULT 'one-shot'::text NOT NULL,
    service_description text NOT NULL,
    adapter_name text NOT NULL,
    agent_domain text,
    supplier text,
    outbound_email_from text,
    inbound_email_address text,
    on_chain_id bytea,
    service_wallet text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    config_revision bigint DEFAULT 1 NOT NULL,
    operator_updated_by text,
    operator_updated_at timestamp with time zone,
    CONSTRAINT services_jurisdictions_check CHECK (((jsonb_typeof(jurisdictions) = 'array'::text) AND (jsonb_array_length(jurisdictions) > 0)))
);

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash bytea NOT NULL,
    user_label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sessions_bounded_lifetime CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '24:00:00'::interval)))),
    CONSTRAINT sessions_token_hash_length CHECK ((octet_length(token_hash) = 32))
);

CREATE TABLE public.settlement_dispositions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    observation_id uuid NOT NULL,
    transaction_id text,
    action text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    reason text NOT NULL,
    escalation_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settlement_dispositions_action_check CHECK ((action = ANY (ARRAY['refund'::text, 'compliance_hold'::text, 'operator_review'::text]))),
    CONSTRAINT settlement_dispositions_reason_check CHECK ((length(reason) <= 256)),
    CONSTRAINT settlement_dispositions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'dispatched'::text, 'closed'::text, 'resolved'::text])))
);

CREATE TABLE public.settlement_observations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chain_id integer NOT NULL,
    router_address text NOT NULL,
    onchain_payment_id numeric(78,0) NOT NULL,
    transaction_hash text NOT NULL,
    block_number numeric(78,0) NOT NULL,
    block_hash text NOT NULL,
    log_index integer NOT NULL,
    confirmations integer NOT NULL,
    service_ref bytea NOT NULL,
    onchain_service_id bytea NOT NULL,
    buyer_agent_id numeric(78,0) NOT NULL,
    provider_agent_id numeric(78,0) NOT NULL,
    token_address text NOT NULL,
    total_amount numeric(78,0) NOT NULL,
    provider_amount numeric(78,0) NOT NULL,
    commission numeric(78,0) NOT NULL,
    state text DEFAULT 'observed'::text NOT NULL,
    disposition_code text,
    disposition_detail text,
    authenticated_wallet text,
    canonical_request_hash bytea,
    transaction_id text,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settlement_observations_amount_positive CHECK ((total_amount > (0)::numeric)),
    CONSTRAINT settlement_observations_disposition_code_check CHECK (((disposition_code IS NULL) OR (disposition_code ~ '^[a-z0-9_]{1,64}$'::text))),
    CONSTRAINT settlement_observations_disposition_detail_check CHECK (((disposition_detail IS NULL) OR (length(disposition_detail) <= 256))),
    CONSTRAINT settlement_observations_state_check CHECK ((state = ANY (ARRAY['observed'::text, 'authenticated'::text, 'materialized'::text, 'fulfilling'::text, 'completed'::text, 'refund_required'::text, 'refunded'::text, 'compliance_hold'::text, 'operator_review'::text]))),
    CONSTRAINT settlement_observations_uint256_check CHECK (((onchain_payment_id >= (0)::numeric) AND (onchain_payment_id <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric) AND ((block_number >= (0)::numeric) AND (block_number <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric)) AND ((buyer_agent_id >= (0)::numeric) AND (buyer_agent_id <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric)) AND ((provider_agent_id >= (0)::numeric) AND (provider_agent_id <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric)) AND ((total_amount >= (1)::numeric) AND (total_amount <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric)) AND ((provider_amount >= (0)::numeric) AND (provider_amount <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric)) AND ((commission >= (0)::numeric) AND (commission <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric))))
);

CREATE TABLE public.siwe_nonces (
    nonce_hash bytea NOT NULL,
    issued_ip_hash bytea NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    CONSTRAINT siwe_nonce_expiry_order CHECK ((expires_at > issued_at)),
    CONSTRAINT siwe_nonce_hash_length CHECK ((octet_length(nonce_hash) = 32)),
    CONSTRAINT siwe_nonce_ip_hash_length CHECK ((octet_length(issued_ip_hash) = 32))
);

CREATE TABLE public.skills (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    service_id uuid NOT NULL,
    skill_id text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    tags jsonb,
    pricing jsonb NOT NULL,
    required_fields jsonb,
    optional_fields jsonb,
    requires_asset_ownership boolean DEFAULT false NOT NULL,
    asset_type text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    fulfillment_mode text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    examples jsonb,
    documentation_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    human_parties text,
    CONSTRAINT skills_fulfillment_mode_check CHECK ((fulfillment_mode = ANY (ARRAY['automated'::text, 'human'::text, 'hybrid'::text]))),
    CONSTRAINT skills_human_parties_check CHECK (((human_parties IS NULL) OR (human_parties = ANY (ARRAY['required'::text, 'varies'::text, 'none'::text]))))
);

CREATE TABLE public.standard_action_nonces (
    payer text NOT NULL,
    nonce bytea NOT NULL,
    order_id text NOT NULL,
    action text NOT NULL,
    consumed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT standard_action_nonces_nonce_check CHECK ((octet_length(nonce) = 32))
);

CREATE TABLE public.standard_asset_action_executions (
    execution_id bytea NOT NULL,
    payer text NOT NULL,
    provider_asset_id uuid NOT NULL,
    action_hash bytea NOT NULL,
    request_hash bytea NOT NULL,
    wallet_authorization_hash bytea NOT NULL,
    grant_hash bytea NOT NULL,
    provider_control_profile_hash bytea NOT NULL,
    servicing_admission_hash bytea NOT NULL,
    action_catalog_hash bytea NOT NULL,
    action_catalog_schema_hash bytea NOT NULL,
    action_catalog_epoch bigint NOT NULL,
    action_definition_hash bytea NOT NULL,
    replay_policy text NOT NULL,
    state text NOT NULL,
    reconciliation_identity text,
    effect_summary jsonb,
    confirmation_hash bytea,
    earliest_execution_at timestamp with time zone,
    stage_valid_before timestamp with time zone,
    result_valid_before timestamp with time zone NOT NULL,
    result_redacted_at timestamp with time zone,
    sanitized_result jsonb,
    error_class text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT standard_asset_action_execut_provider_control_profile_has_check CHECK ((octet_length(provider_control_profile_hash) = 32)),
    CONSTRAINT standard_asset_action_executio_action_catalog_schema_hash_check CHECK ((octet_length(action_catalog_schema_hash) = 32)),
    CONSTRAINT standard_asset_action_execution_wallet_authorization_hash_check CHECK ((octet_length(wallet_authorization_hash) = 32)),
    CONSTRAINT standard_asset_action_executions_action_catalog_hash_check CHECK ((octet_length(action_catalog_hash) = 32)),
    CONSTRAINT standard_asset_action_executions_action_definition_hash_check CHECK ((octet_length(action_definition_hash) = 32)),
    CONSTRAINT standard_asset_action_executions_action_hash_check CHECK ((octet_length(action_hash) = 32)),
    CONSTRAINT standard_asset_action_executions_confirmation_hash_check CHECK (((confirmation_hash IS NULL) OR (octet_length(confirmation_hash) = 32))),
    CONSTRAINT standard_asset_action_executions_execution_id_check CHECK ((octet_length(execution_id) = 32)),
    CONSTRAINT standard_asset_action_executions_grant_hash_check CHECK ((octet_length(grant_hash) = 32)),
    CONSTRAINT standard_asset_action_executions_replay_policy_check CHECK ((replay_policy = ANY (ARRAY['stable-result'::text, 'regenerate-ephemeral'::text, 'redacted-after-window'::text]))),
    CONSTRAINT standard_asset_action_executions_request_hash_check CHECK ((octet_length(request_hash) = 32)),
    CONSTRAINT standard_asset_action_executions_servicing_admission_hash_check CHECK ((octet_length(servicing_admission_hash) = 32)),
    CONSTRAINT standard_asset_action_executions_state_check CHECK ((state = ANY (ARRAY['claimed'::text, 'staged'::text, 'executing'::text, 'completed'::text, 'failed'::text, 'canceled'::text, 'expired'::text, 'attention'::text]))),
    CONSTRAINT standard_asset_action_result_check CHECK ((((state = 'completed'::text) AND (error_class IS NULL) AND (sanitized_result IS NULL)) OR ((state = 'failed'::text) AND (sanitized_result IS NULL) AND (error_class IS NOT NULL)) OR ((state <> ALL (ARRAY['completed'::text, 'failed'::text])) AND (sanitized_result IS NULL) AND (error_class IS NULL))))
);

CREATE TABLE public.standard_asset_action_recovery_executions (
    recovery_execution_id bytea NOT NULL,
    action_execution_id bytea NOT NULL,
    payer text NOT NULL,
    wallet_authorization_hash bytea NOT NULL,
    request_hash bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT standard_asset_action_recovery__wallet_authorization_hash_check CHECK ((octet_length(wallet_authorization_hash) = 32)),
    CONSTRAINT standard_asset_action_recovery_exec_recovery_execution_id_check CHECK ((octet_length(recovery_execution_id) = 32)),
    CONSTRAINT standard_asset_action_recovery_executions_request_hash_check CHECK ((octet_length(request_hash) = 32))
);

CREATE TABLE public.standard_asset_action_recovery_results (
    execution_id bytea NOT NULL,
    encrypted_result text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT standard_asset_action_recovery_results_encrypted_result_check CHECK ((encrypted_result ~~ 'daski:v1:%'::text))
);

CREATE TABLE public.standard_asset_rate_buckets (
    scope text NOT NULL,
    key_hash bytea NOT NULL,
    window_started_at timestamp with time zone DEFAULT now() NOT NULL,
    request_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT standard_asset_rate_buckets_key_hash_check CHECK ((octet_length(key_hash) = 32)),
    CONSTRAINT standard_asset_rate_buckets_request_count_check CHECK ((request_count >= 0)),
    CONSTRAINT standard_asset_rate_buckets_scope_check CHECK ((scope = ANY (ARRAY['gateway-signer'::text, 'payer'::text, 'provider-action'::text, 'global'::text])))
);

CREATE TABLE public.standard_destructive_action_payloads (
    execution_id bytea NOT NULL,
    encrypted_input text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.standard_destructive_followup_executions (
    followup_execution_id bytea NOT NULL,
    action_execution_id bytea NOT NULL,
    payer text NOT NULL,
    operation text NOT NULL,
    confirmation_hash bytea NOT NULL,
    wallet_authorization_hash bytea NOT NULL,
    request_hash bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT standard_destructive_followup_e_wallet_authorization_hash_check CHECK ((octet_length(wallet_authorization_hash) = 32)),
    CONSTRAINT standard_destructive_followup_execu_followup_execution_id_check CHECK ((octet_length(followup_execution_id) = 32)),
    CONSTRAINT standard_destructive_followup_execution_confirmation_hash_check CHECK ((octet_length(confirmation_hash) = 32)),
    CONSTRAINT standard_destructive_followup_executions_operation_check CHECK ((operation = ANY (ARRAY['confirm'::text, 'cancel'::text]))),
    CONSTRAINT standard_destructive_followup_executions_request_hash_check CHECK ((octet_length(request_hash) = 32))
);

CREATE TABLE public.standard_dispatch_claims (
    gateway_audience text NOT NULL,
    order_id text NOT NULL,
    dispatch_nonce bytea NOT NULL,
    dispatch_hash bytea NOT NULL,
    request_hash bytea NOT NULL,
    payer text NOT NULL,
    transaction_id text,
    state text NOT NULL,
    response_hash bytea,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT standard_dispatch_claims_dispatch_hash_check CHECK ((octet_length(dispatch_hash) = 32)),
    CONSTRAINT standard_dispatch_claims_dispatch_nonce_check CHECK ((octet_length(dispatch_nonce) = 32)),
    CONSTRAINT standard_dispatch_claims_request_hash_check CHECK ((octet_length(request_hash) = 32)),
    CONSTRAINT standard_dispatch_claims_response_hash_check CHECK (((response_hash IS NULL) OR (octet_length(response_hash) = 32))),
    CONSTRAINT standard_dispatch_claims_state_check CHECK ((state = ANY (ARRAY['claimed'::text, 'dispatching'::text, 'submitted'::text, 'working'::text, 'input-required'::text, 'completed'::text, 'failed'::text, 'canceled'::text])))
);

CREATE TABLE public.standard_evidence_admissions (
    evidence_hash bytea NOT NULL,
    order_id text NOT NULL,
    evidence_kind text NOT NULL,
    transaction_hash text NOT NULL,
    block_number bigint NOT NULL,
    block_hash text NOT NULL,
    transaction_index integer NOT NULL,
    log_index integer NOT NULL,
    release_sequence numeric(20,0),
    source_fingerprints jsonb NOT NULL,
    canonical_evidence jsonb NOT NULL,
    admitted_at timestamp with time zone DEFAULT now() NOT NULL,
    authorization_key bytea,
    CONSTRAINT standard_evidence_admissions_authorization_key_check CHECK (((authorization_key IS NULL) OR (octet_length(authorization_key) = 32))),
    CONSTRAINT standard_evidence_admissions_check CHECK ((((evidence_kind = 'deposit'::text) AND (release_sequence IS NULL)) OR ((evidence_kind = 'release'::text) AND ((release_sequence >= (1)::numeric) AND (release_sequence <= '18446744073709551615'::numeric))))),
    CONSTRAINT standard_evidence_admissions_evidence_hash_check CHECK ((octet_length(evidence_hash) = 32)),
    CONSTRAINT standard_evidence_admissions_evidence_kind_check CHECK ((evidence_kind = ANY (ARRAY['deposit'::text, 'release'::text]))),
    CONSTRAINT standard_evidence_admissions_log_index_check CHECK ((log_index >= 0)),
    CONSTRAINT standard_evidence_admissions_transaction_index_check CHECK ((transaction_index >= 0))
);

CREATE TABLE public.standard_provider_grant_nonces (
    grant_nonce bytea NOT NULL,
    grant_hash bytea NOT NULL,
    payer text NOT NULL,
    consumed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT standard_provider_grant_nonces_grant_hash_check CHECK ((octet_length(grant_hash) = 32)),
    CONSTRAINT standard_provider_grant_nonces_grant_nonce_check CHECK ((octet_length(grant_nonce) = 32))
);

CREATE TABLE public.standard_provider_quotes (
    quote_hash bytea NOT NULL,
    outcome_id text NOT NULL,
    listing_manifest_hash bytea NOT NULL,
    request_hash bytea NOT NULL,
    gross_amount numeric(78,0) NOT NULL,
    supplier_cost_ceiling jsonb,
    issued_at timestamp with time zone NOT NULL,
    valid_before timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT standard_provider_quotes_gross_amount_check CHECK ((gross_amount > (0)::numeric)),
    CONSTRAINT standard_provider_quotes_listing_manifest_hash_check CHECK ((octet_length(listing_manifest_hash) = 32)),
    CONSTRAINT standard_provider_quotes_quote_hash_check CHECK ((octet_length(quote_hash) = 32)),
    CONSTRAINT standard_provider_quotes_request_hash_check CHECK ((octet_length(request_hash) = 32))
);

CREATE TABLE public.standard_reputation_outcomes (
    order_key bytea NOT NULL,
    transaction_id text NOT NULL,
    outcome smallint NOT NULL,
    state text NOT NULL,
    transaction_hash text,
    attempt_count smallint DEFAULT 0 NOT NULL,
    retry_once_used boolean DEFAULT false NOT NULL,
    provider_write_id uuid,
    next_attempt_at timestamp with time zone DEFAULT now(),
    last_error_class text,
    final_block_number bigint,
    final_block_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    attestation_uid bytea,
    CONSTRAINT standard_reputation_outcomes_attempt_count_check CHECK (((attempt_count >= 0) AND (attempt_count <= 5))),
    CONSTRAINT standard_reputation_outcomes_attestation_uid_check CHECK (((attestation_uid IS NULL) OR (octet_length(attestation_uid) = 32))),
    CONSTRAINT standard_reputation_outcomes_order_key_check CHECK ((octet_length(order_key) = 32)),
    CONSTRAINT standard_reputation_outcomes_outcome_check CHECK (((outcome >= 0) AND (outcome <= 2))),
    CONSTRAINT standard_reputation_outcomes_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'broadcast'::text, 'final'::text, 'operator_attention'::text, 'aborted_unattested'::text])))
);

CREATE TABLE public.standard_security_incidents (
    incident_id uuid NOT NULL,
    incident_kind text NOT NULL,
    gateway_audience text,
    order_id text,
    fingerprint bytea NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT standard_security_incidents_fingerprint_check CHECK ((octet_length(fingerprint) = 32))
);

CREATE TABLE public.standard_wallet_action_nonces (
    payer text NOT NULL,
    nonce bytea NOT NULL,
    action_hash bytea NOT NULL,
    request_hash bytea NOT NULL,
    wallet_authorization_hash bytea NOT NULL,
    consumed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT standard_wallet_action_nonces_action_hash_check CHECK ((octet_length(action_hash) = 32)),
    CONSTRAINT standard_wallet_action_nonces_nonce_check CHECK ((octet_length(nonce) = 32)),
    CONSTRAINT standard_wallet_action_nonces_request_hash_check CHECK ((octet_length(request_hash) = 32)),
    CONSTRAINT standard_wallet_action_nonces_wallet_authorization_hash_check CHECK ((octet_length(wallet_authorization_hash) = 32))
);

CREATE TABLE public.supplier_breaker_failures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    supplier text NOT NULL,
    transaction_id text NOT NULL,
    failure_kind text NOT NULL,
    failure_key text,
    failed_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.supplier_circuit_breakers (
    supplier text NOT NULL,
    state text DEFAULT 'closed'::text NOT NULL,
    opened_at timestamp with time zone,
    open_until timestamp with time zone,
    failure_count integer DEFAULT 0 NOT NULL,
    task_count integer DEFAULT 0 NOT NULL,
    escalation_id uuid,
    generation bigint DEFAULT 0 NOT NULL,
    probe_token uuid,
    probe_expires_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT supplier_circuit_breakers_generation_check CHECK ((generation >= 0)),
    CONSTRAINT supplier_circuit_breakers_probe_check CHECK ((((state = 'half_open'::text) AND (probe_token IS NOT NULL) AND (probe_expires_at IS NOT NULL)) OR ((state <> 'half_open'::text) AND (probe_token IS NULL) AND (probe_expires_at IS NULL)))),
    CONSTRAINT supplier_circuit_breakers_state_check CHECK ((state = ANY (ARRAY['closed'::text, 'open'::text, 'half_open'::text])))
);

CREATE TABLE public.supplier_configs (
    supplier text NOT NULL,
    credentials_encrypted text NOT NULL,
    sandbox boolean DEFAULT false NOT NULL,
    notes text,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    config_revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT supplier_notes_envelope_check CHECK (((notes IS NULL) OR (notes ~~ 'daski:v1:%'::text)))
);

CREATE TABLE public.supplier_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    service_id uuid NOT NULL,
    transaction_id text,
    op_key text NOT NULL,
    kind text NOT NULL,
    state text DEFAULT 'intent'::text NOT NULL,
    request_fingerprint text,
    result jsonb,
    attempts integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    error_code text,
    CONSTRAINT supplier_operations_error_code_format CHECK (((error_code IS NULL) OR ((length(error_code) >= 3) AND (length(error_code) <= 64) AND (error_code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$'::text)))),
    CONSTRAINT supplier_operations_state_check CHECK ((state = ANY (ARRAY['intent'::text, 'ambiguous'::text, 'confirmed'::text, 'failed'::text])))
);

CREATE TABLE public.transactions (
    id text NOT NULL,
    asset_id uuid,
    service_id uuid NOT NULL,
    skill_id text NOT NULL,
    service_ref bytea,
    status text NOT NULL,
    contact_email text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    version bigint DEFAULT 1 NOT NULL,
    canonical_request_hash bytea,
    retention_class text DEFAULT 'persistent'::text NOT NULL,
    expires_at timestamp with time zone,
    request_id_hash bytea,
    accepted_envelope_message_id_hash bytea,
    standard_order_id text,
    standard_payer text,
    standard_listing_manifest_hash bytea,
    standard_provider_offer_hash bytea,
    standard_deposit_evidence_hash bytea,
    standard_release_evidence_hash bytea,
    standard_token text,
    standard_gross_amount numeric(78,0),
    standard_provider_net_amount numeric(78,0),
    standard_daski_commission_amount numeric(78,0),
    customer_id uuid,
    standard_order_key bytea,
    standard_action_execution_id bytea,
    CONSTRAINT transactions_contact_email_envelope_check CHECK (((contact_email IS NULL) OR (contact_email ~~ 'daski:v1:%'::text))),
    CONSTRAINT transactions_envelope_message_id_hash_length CHECK (((accepted_envelope_message_id_hash IS NULL) OR (octet_length(accepted_envelope_message_id_hash) = 32))),
    CONSTRAINT transactions_ephemeral_expiry_check CHECK ((((retention_class = 'persistent'::text) AND (expires_at IS NULL) AND (request_id_hash IS NULL)) OR ((retention_class = 'ephemeral'::text) AND (expires_at IS NOT NULL) AND (request_id_hash IS NOT NULL)))),
    CONSTRAINT transactions_retention_class_check CHECK ((retention_class = ANY (ARRAY['persistent'::text, 'ephemeral'::text]))),
    CONSTRAINT transactions_standard_action_execution_id_check CHECK (((standard_action_execution_id IS NULL) OR (octet_length(standard_action_execution_id) = 32))),
    CONSTRAINT transactions_standard_amounts_check CHECK ((((standard_order_id IS NULL) AND (standard_token IS NULL) AND (standard_gross_amount IS NULL) AND (standard_provider_net_amount IS NULL) AND (standard_daski_commission_amount IS NULL)) OR ((standard_order_id IS NOT NULL) AND (standard_token IS NOT NULL) AND (standard_gross_amount > (0)::numeric) AND (standard_provider_net_amount > (0)::numeric) AND (standard_daski_commission_amount > (0)::numeric) AND ((standard_provider_net_amount + standard_daski_commission_amount) = standard_gross_amount)))),
    CONSTRAINT transactions_standard_authority_check CHECK ((((standard_order_id IS NULL) AND (standard_order_key IS NULL) AND (standard_action_execution_id IS NULL) AND (standard_payer IS NULL) AND (customer_id IS NULL)) OR ((standard_order_id IS NOT NULL) AND (standard_action_execution_id IS NULL) AND (standard_order_key IS NOT NULL) AND (standard_payer IS NOT NULL) AND (customer_id IS NOT NULL)) OR ((standard_order_id IS NULL) AND (standard_action_execution_id IS NOT NULL) AND (standard_payer IS NOT NULL) AND (customer_id IS NOT NULL)))),
    CONSTRAINT transactions_standard_hashes_check CHECK ((((standard_listing_manifest_hash IS NULL) OR (octet_length(standard_listing_manifest_hash) = 32)) AND ((standard_provider_offer_hash IS NULL) OR (octet_length(standard_provider_offer_hash) = 32)) AND ((standard_deposit_evidence_hash IS NULL) OR (octet_length(standard_deposit_evidence_hash) = 32)) AND ((standard_release_evidence_hash IS NULL) OR (octet_length(standard_release_evidence_hash) = 32)))),
    CONSTRAINT transactions_standard_order_key_check CHECK (((standard_order_key IS NULL) OR (octet_length(standard_order_key) = 32))),
    CONSTRAINT transactions_status_check CHECK ((status = ANY (ARRAY['submitted'::text, 'working'::text, 'input-required'::text, 'completed'::text, 'failed'::text, 'canceled'::text])))
);

ALTER TABLE ONLY public.artifact_secrets
    ADD CONSTRAINT artifact_secrets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.artifact_secrets
    ADD CONSTRAINT artifact_secrets_transaction_id_artifact_name_field_path_key UNIQUE (transaction_id, artifact_name, field_path);

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.auth_rate_limit_buckets
    ADD CONSTRAINT auth_rate_limit_buckets_pkey PRIMARY KEY (key_hash);

ALTER TABLE ONLY public.blocked_identities
    ADD CONSTRAINT blocked_identities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.compliance_cases
    ADD CONSTRAINT compliance_cases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.compliance_cases
    ADD CONSTRAINT compliance_cases_screening_check_id_key UNIQUE (screening_check_id);

ALTER TABLE ONLY public.compliance_governance_approvals
    ADD CONSTRAINT compliance_governance_approvals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.compliance_sweep_runs
    ADD CONSTRAINT compliance_sweep_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_wallet_address_key UNIQUE (wallet_address);

ALTER TABLE ONLY public.durable_jobs
    ADD CONSTRAINT durable_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.durable_jobs
    ADD CONSTRAINT durable_jobs_queue_idempotency_key_key UNIQUE (queue, idempotency_key);

ALTER TABLE ONLY public.emails_inbound
    ADD CONSTRAINT emails_inbound_message_id_key UNIQUE (message_id);

ALTER TABLE ONLY public.emails_inbound
    ADD CONSTRAINT emails_inbound_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.emails_outbound
    ADD CONSTRAINT emails_outbound_idempotency_key_key UNIQUE (idempotency_key);

ALTER TABLE ONLY public.emails_outbound
    ADD CONSTRAINT emails_outbound_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.escalations
    ADD CONSTRAINT escalations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fulfillment_hold_attempts
    ADD CONSTRAINT fulfillment_hold_attempts_escalation_id_attempt_seq_key UNIQUE (escalation_id, attempt_seq);

ALTER TABLE ONLY public.fulfillment_hold_attempts
    ADD CONSTRAINT fulfillment_hold_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.legal_holds
    ADD CONSTRAINT legal_holds_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.operator_chats
    ADD CONSTRAINT operator_chats_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.operator_config_revisions
    ADD CONSTRAINT operator_config_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.operator_config_revisions
    ADD CONSTRAINT operator_config_revisions_resource_type_resource_key_revisi_key UNIQUE (resource_type, resource_key, revision);

ALTER TABLE ONLY public.operator_confirmation_intents
    ADD CONSTRAINT operator_confirmation_intents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.operator_confirmation_intents
    ADD CONSTRAINT operator_confirmation_intents_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.protected_data_rotation_progress
    ADD CONSTRAINT protected_data_rotation_progress_pkey PRIMARY KEY (run_id, sink);

ALTER TABLE ONLY public.protected_data_rotation_roles
    ADD CONSTRAINT protected_data_rotation_roles_pkey PRIMARY KEY (role_name);

ALTER TABLE ONLY public.protected_data_rotation_runs
    ADD CONSTRAINT protected_data_rotation_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.provider_chain_writes
    ADD CONSTRAINT provider_chain_writes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.provider_quotes
    ADD CONSTRAINT provider_quotes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.provider_quotes
    ADD CONSTRAINT provider_quotes_service_ref_key UNIQUE (service_ref);

ALTER TABLE ONLY public.provider_signer_cursors
    ADD CONSTRAINT provider_signer_cursors_pkey PRIMARY KEY (chain_id, wallet_address);

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_transaction_id_url_key UNIQUE (transaction_id, url);

ALTER TABLE ONLY public.rate_limit_buckets
    ADD CONSTRAINT rate_limit_buckets_pkey PRIMARY KEY (bucket_key);

ALTER TABLE ONLY public.reputation_submissions
    ADD CONSTRAINT reputation_submissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.service_rules
    ADD CONSTRAINT service_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_slug_version_key UNIQUE (slug, version);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.settlement_dispositions
    ADD CONSTRAINT settlement_dispositions_observation_id_key UNIQUE (observation_id);

ALTER TABLE ONLY public.settlement_dispositions
    ADD CONSTRAINT settlement_dispositions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.settlement_observations
    ADD CONSTRAINT settlement_observations_chain_id_router_address_onchain_pay_key UNIQUE (chain_id, router_address, onchain_payment_id);

ALTER TABLE ONLY public.settlement_observations
    ADD CONSTRAINT settlement_observations_chain_id_transaction_hash_log_index_key UNIQUE (chain_id, transaction_hash, log_index);

ALTER TABLE ONLY public.settlement_observations
    ADD CONSTRAINT settlement_observations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.siwe_nonces
    ADD CONSTRAINT siwe_nonces_pkey PRIMARY KEY (nonce_hash);

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_service_id_skill_id_key UNIQUE (service_id, skill_id);

ALTER TABLE ONLY public.standard_action_nonces
    ADD CONSTRAINT standard_action_nonces_pkey PRIMARY KEY (payer, nonce);

ALTER TABLE ONLY public.standard_asset_action_executions
    ADD CONSTRAINT standard_asset_action_executions_pkey PRIMARY KEY (execution_id);

ALTER TABLE ONLY public.standard_asset_action_recovery_executions
    ADD CONSTRAINT standard_asset_action_recovery_executions_pkey PRIMARY KEY (recovery_execution_id);

ALTER TABLE ONLY public.standard_asset_action_recovery_results
    ADD CONSTRAINT standard_asset_action_recovery_results_pkey PRIMARY KEY (execution_id);

ALTER TABLE ONLY public.standard_asset_rate_buckets
    ADD CONSTRAINT standard_asset_rate_buckets_pkey PRIMARY KEY (scope, key_hash);

ALTER TABLE ONLY public.standard_destructive_action_payloads
    ADD CONSTRAINT standard_destructive_action_payloads_pkey PRIMARY KEY (execution_id);

ALTER TABLE ONLY public.standard_destructive_followup_executions
    ADD CONSTRAINT standard_destructive_followup_executions_pkey PRIMARY KEY (followup_execution_id);

ALTER TABLE ONLY public.standard_dispatch_claims
    ADD CONSTRAINT standard_dispatch_claims_dispatch_hash_key UNIQUE (dispatch_hash);

ALTER TABLE ONLY public.standard_dispatch_claims
    ADD CONSTRAINT standard_dispatch_claims_gateway_audience_dispatch_nonce_key UNIQUE (gateway_audience, dispatch_nonce);

ALTER TABLE ONLY public.standard_dispatch_claims
    ADD CONSTRAINT standard_dispatch_claims_pkey PRIMARY KEY (gateway_audience, order_id);

ALTER TABLE ONLY public.standard_evidence_admissions
    ADD CONSTRAINT standard_evidence_admissions_order_id_evidence_kind_transac_key UNIQUE (order_id, evidence_kind, transaction_hash, log_index);

ALTER TABLE ONLY public.standard_evidence_admissions
    ADD CONSTRAINT standard_evidence_admissions_pkey PRIMARY KEY (evidence_hash);

ALTER TABLE ONLY public.standard_provider_grant_nonces
    ADD CONSTRAINT standard_provider_grant_nonces_grant_hash_key UNIQUE (grant_hash);

ALTER TABLE ONLY public.standard_provider_grant_nonces
    ADD CONSTRAINT standard_provider_grant_nonces_pkey PRIMARY KEY (grant_nonce);

ALTER TABLE ONLY public.standard_provider_quotes
    ADD CONSTRAINT standard_provider_quotes_pkey PRIMARY KEY (quote_hash);

ALTER TABLE ONLY public.standard_reputation_outcomes
    ADD CONSTRAINT standard_reputation_outcomes_pkey PRIMARY KEY (order_key);

ALTER TABLE ONLY public.standard_reputation_outcomes
    ADD CONSTRAINT standard_reputation_outcomes_transaction_hash_key UNIQUE (transaction_hash);

ALTER TABLE ONLY public.standard_reputation_outcomes
    ADD CONSTRAINT standard_reputation_outcomes_transaction_id_key UNIQUE (transaction_id);

ALTER TABLE ONLY public.standard_security_incidents
    ADD CONSTRAINT standard_security_incidents_incident_kind_fingerprint_key UNIQUE (incident_kind, fingerprint);

ALTER TABLE ONLY public.standard_security_incidents
    ADD CONSTRAINT standard_security_incidents_pkey PRIMARY KEY (incident_id);

ALTER TABLE ONLY public.standard_wallet_action_nonces
    ADD CONSTRAINT standard_wallet_action_nonces_pkey PRIMARY KEY (payer, nonce);

ALTER TABLE ONLY public.standard_wallet_action_nonces
    ADD CONSTRAINT standard_wallet_action_nonces_wallet_authorization_hash_key UNIQUE (wallet_authorization_hash);

ALTER TABLE ONLY public.supplier_breaker_failures
    ADD CONSTRAINT supplier_breaker_failures_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.supplier_circuit_breakers
    ADD CONSTRAINT supplier_circuit_breakers_pkey PRIMARY KEY (supplier);

ALTER TABLE ONLY public.supplier_configs
    ADD CONSTRAINT supplier_configs_pkey PRIMARY KEY (supplier);

ALTER TABLE ONLY public.supplier_operations
    ADD CONSTRAINT supplier_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.supplier_operations
    ADD CONSTRAINT supplier_operations_service_id_op_key_key UNIQUE (service_id, op_key);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_service_ref_key UNIQUE (service_ref);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_standard_action_execution_id_key UNIQUE (standard_action_execution_id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_standard_order_id_key UNIQUE (standard_order_id);

CREATE INDEX artifact_secrets_tx_idx ON public.artifact_secrets USING btree (transaction_id);

CREATE INDEX assets_identifier_hash_idx ON public.assets USING btree (identifier_hash);

CREATE UNIQUE INDEX assets_live_unique ON public.assets USING btree (service_id, identifier_hash) WHERE (status = ANY (ARRAY['active'::text, 'suspended'::text, 'expired'::text]));

CREATE INDEX assets_status_idx ON public.assets USING btree (status);

CREATE INDEX auth_rate_limit_expiry_idx ON public.auth_rate_limit_buckets USING btree (expires_at);

CREATE INDEX blocked_identities_wallet_idx ON public.blocked_identities USING btree (lower(wallet_address)) WHERE (removed_at IS NULL);

CREATE UNIQUE INDEX chat_threads_escalation_idx ON public.chat_threads USING btree (escalation_id) WHERE (escalation_id IS NOT NULL);

CREATE UNIQUE INDEX chat_threads_freeform_idx ON public.chat_threads USING btree (wallet_address) WHERE (escalation_id IS NULL);

CREATE INDEX chat_threads_wallet_idx ON public.chat_threads USING btree (wallet_address, updated_at DESC);

CREATE INDEX compliance_cases_deadline_idx ON public.compliance_cases USING btree (counsel_due_at, report_due_at) WHERE (status <> 'closed'::text);

CREATE UNIQUE INDEX compliance_governance_approval_evidence_unique ON public.compliance_governance_approvals USING btree (environment, chain_id, rules_version, country_mapping_version, lower(blocked_funds_address), evidence_reference_hash);

CREATE UNIQUE INDEX compliance_governance_approval_policy_unique ON public.compliance_governance_approvals USING btree (environment, chain_id, policy_hash, lower(blocked_funds_address), evidence_reference_hash);

CREATE INDEX compliance_sweep_due_idx ON public.compliance_sweep_runs USING btree (next_due_at DESC, completed_at DESC);

CREATE INDEX customers_email_hash_idx ON public.customers USING btree (last_known_email_hash) WHERE (last_known_email_hash IS NOT NULL);

CREATE INDEX durable_jobs_claim_idx ON public.durable_jobs USING btree (queue, available_at, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'retry'::text]));

CREATE INDEX durable_jobs_dead_letter_unsurfaced ON public.durable_jobs USING btree (updated_at) WHERE ((status = 'dead_letter'::text) AND (dead_letter_surfaced_at IS NULL));

CREATE INDEX durable_jobs_lease_idx ON public.durable_jobs USING btree (lease_expires_at) WHERE (status = 'running'::text);

CREATE INDEX emails_inbound_processing_idx ON public.emails_inbound USING btree (processing_status, processing_available_at, received_at) WHERE (processing_status = ANY (ARRAY['queued'::text, 'retry'::text, 'running'::text]));

CREATE INDEX emails_inbound_received_idx ON public.emails_inbound USING btree (received_at DESC);

CREATE INDEX emails_inbound_thread_hash_idx ON public.emails_inbound USING btree (thread_root_hash, received_at DESC);

CREATE INDEX emails_inbound_thread_idx ON public.emails_inbound USING btree (thread_root, received_at DESC);

CREATE INDEX emails_inbound_to_hash_idx ON public.emails_inbound USING btree (to_address_hash, received_at DESC);

CREATE INDEX emails_inbound_tx_idx ON public.emails_inbound USING btree (transaction_id, received_at DESC);

CREATE INDEX emails_inbound_unclassified_idx ON public.emails_inbound USING btree (received_at) WHERE ((classification IS NULL) OR (classification = 'unknown'::text));

CREATE INDEX emails_outbound_message_id_idx ON public.emails_outbound USING btree (message_id) WHERE (message_id IS NOT NULL);

CREATE INDEX emails_outbound_sent_idx ON public.emails_outbound USING btree (sent_at DESC);

CREATE INDEX emails_outbound_thread_hash_idx ON public.emails_outbound USING btree (thread_root_hash, sent_at DESC);

CREATE INDEX emails_outbound_thread_idx ON public.emails_outbound USING btree (thread_root, sent_at DESC);

CREATE INDEX emails_outbound_tx_idx ON public.emails_outbound USING btree (transaction_id, sent_at DESC);

CREATE INDEX escalations_created_idx ON public.escalations USING btree (created_at DESC);

CREATE INDEX escalations_fulfillment_resume_idx ON public.escalations USING btree (fulfillment_resume_at) WHERE ((source = 'fulfillment_hold'::text) AND (status = 'resolution_queued'::text));

CREATE UNIQUE INDEX escalations_one_open_fulfillment_hold_idx ON public.escalations USING btree (transaction_id) WHERE ((source = 'fulfillment_hold'::text) AND (status = ANY (ARRAY['pending'::text, 'in_agent_review'::text, 'awaiting_human'::text, 'resolution_queued'::text, 'rejection_queued'::text, 'resolution_executing'::text, 'resolution_result_ready'::text, 'resolution_attention'::text])));

CREATE UNIQUE INDEX escalations_one_open_preexecute_idx ON public.escalations USING btree (transaction_id) WHERE ((source = 'pre_execute'::text) AND (status = ANY (ARRAY['pending'::text, 'resolution_queued'::text, 'rejection_queued'::text, 'resolution_executing'::text, 'resolution_result_ready'::text, 'resolution_attention'::text])));

CREATE UNIQUE INDEX escalations_open_dedupe_key ON public.escalations USING btree (dedupe_key) WHERE ((dedupe_key IS NOT NULL) AND (status = ANY (ARRAY['pending'::text, 'in_agent_review'::text, 'awaiting_human'::text, 'resolution_queued'::text, 'rejection_queued'::text, 'resolution_executing'::text, 'resolution_result_ready'::text, 'resolution_attention'::text])));

CREATE INDEX escalations_operator_dispatch_idx ON public.escalations USING btree (status, created_at) WHERE (status = 'in_agent_review'::text);

CREATE INDEX escalations_pending_idx ON public.escalations USING btree (status) WHERE (status = 'pending'::text);

CREATE INDEX escalations_resolution_recovery_idx ON public.escalations USING btree (status, resolution_claimed_at) WHERE (status = ANY (ARRAY['resolution_queued'::text, 'rejection_queued'::text, 'resolution_executing'::text, 'resolution_result_ready'::text, 'resolution_attention'::text]));

CREATE INDEX escalations_review_queue ON public.escalations USING btree (status, severity, review_due_at, last_seen_at DESC) WHERE (status = ANY (ARRAY['pending'::text, 'in_agent_review'::text, 'awaiting_human'::text, 'resolution_attention'::text]));

CREATE INDEX escalations_review_target ON public.escalations USING btree (target_type, target_id) WHERE ((target_type IS NOT NULL) AND (target_id IS NOT NULL));

CREATE INDEX escalations_tx_idx ON public.escalations USING btree (transaction_id);

CREATE INDEX events_created_at_idx ON public.events USING btree (created_at);

CREATE INDEX events_service_idx ON public.events USING btree (service_id, created_at DESC);

CREATE INDEX events_severity_idx ON public.events USING btree (severity, created_at DESC);

CREATE INDEX events_source_idx ON public.events USING btree (source, created_at DESC);

CREATE INDEX events_tx_idx ON public.events USING btree (transaction_id, created_at DESC);

CREATE INDEX events_type_idx ON public.events USING btree (type, created_at DESC);

CREATE INDEX fulfillment_hold_attempts_escalation_idx ON public.fulfillment_hold_attempts USING btree (escalation_id, archived_at);

CREATE UNIQUE INDEX legal_holds_one_active_scope ON public.legal_holds USING btree (scope_type, scope_id) WHERE (released_at IS NULL);

CREATE INDEX operator_chats_retention_idx ON public.operator_chats USING btree (created_at) WHERE (NOT legal_hold);

CREATE INDEX operator_chats_thread_idx ON public.operator_chats USING btree (thread_id, created_at DESC, id DESC);

CREATE INDEX operator_chats_wallet_idx ON public.operator_chats USING btree (wallet_address, created_at);

CREATE INDEX operator_confirmation_binding_idx ON public.operator_confirmation_intents USING btree (thread_id, action_name, target_type, target_id) WHERE ((consumed_at IS NULL) AND (voided_at IS NULL));

CREATE INDEX operator_confirmation_execution_idx ON public.operator_confirmation_intents USING btree (execution_status, execution_started_at) WHERE (execution_status = ANY (ARRAY['executing'::text, 'failed'::text, 'outcome_unknown'::text]));

CREATE INDEX operator_confirmation_expiry_idx ON public.operator_confirmation_intents USING btree (expires_at) WHERE (consumed_at IS NULL);

CREATE INDEX operator_confirmation_session_idx ON public.operator_confirmation_intents USING btree (session_id, issued_at DESC);

CREATE UNIQUE INDEX payments_authoritative_settlement_unique ON public.payments USING btree (chain_id, lower(router_address), onchain_payment_id) WHERE (amount > (0)::numeric);

CREATE INDEX payments_onchain_id_idx ON public.payments USING btree (onchain_payment_id);

CREATE UNIQUE INDEX payments_one_live_auto_refund_proposal_idx ON public.payments USING btree (transaction_id, ((metadata #>> '{auto_refund,class}'::text[]))) WHERE ((amount < (0)::numeric) AND (status = 'proposed'::text) AND ((metadata ->> 'auto'::text) = 'true'::text) AND ((metadata #>> '{auto_refund,class}'::text[]) IS NOT NULL));

CREATE INDEX payments_refund_compliance_hold_idx ON public.payments USING btree (updated_at) WHERE ((amount < (0)::numeric) AND (status = 'compliance_hold'::text));

CREATE INDEX payments_refund_reconciliation_idx ON public.payments USING btree (status, updated_at) WHERE ((amount < (0)::numeric) AND (status = ANY (ARRAY['reserved'::text, 'approval_broadcast'::text, 'broadcast'::text, 'pending_confirmation'::text, 'reconciliation_required'::text])));

CREATE INDEX payments_service_ref_idx ON public.payments USING btree (service_ref);

CREATE INDEX payments_status_idx ON public.payments USING btree (status);

CREATE INDEX payments_tx_idx ON public.payments USING btree (transaction_id);

CREATE UNIQUE INDEX provider_chain_writes_current_nonce ON public.provider_chain_writes USING btree (chain_id, wallet_address, nonce) WHERE (status <> 'replaced'::text);

CREATE UNIQUE INDEX provider_chain_writes_hash ON public.provider_chain_writes USING btree (chain_id, wallet_address, transaction_hash);

CREATE INDEX provider_chain_writes_reconcile ON public.provider_chain_writes USING btree (status, updated_at) WHERE (status = ANY (ARRAY['prepared'::text, 'broadcast'::text, 'attention'::text]));

CREATE INDEX provider_chain_writes_target ON public.provider_chain_writes USING btree (target_type, target_id, created_at DESC);

CREATE INDEX provider_quotes_expiry_idx ON public.provider_quotes USING btree (expires_at);

CREATE INDEX push_subscriptions_health_idx ON public.push_subscriptions USING btree (failure_count, last_attempt_at);

CREATE INDEX rate_limit_buckets_expiry_idx ON public.rate_limit_buckets USING btree (expires_at);

CREATE INDEX reputation_submissions_pending_idx ON public.reputation_submissions USING btree (status) WHERE (status = ANY (ARRAY['pending'::text, 'submitted'::text]));

CREATE INDEX reputation_submissions_reconcile ON public.reputation_submissions USING btree (status, next_action_at, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'submitted'::text, 'reconciliation_required'::text]));

CREATE UNIQUE INDEX reputation_submissions_tx_payment_uniq ON public.reputation_submissions USING btree (transaction_id, payment_id);

CREATE INDEX service_rules_active_idx ON public.service_rules USING btree (service_id, active);

CREATE INDEX service_rules_skill_idx ON public.service_rules USING btree (skill_id, active);

CREATE UNIQUE INDEX services_inbound_email_idx ON public.services USING btree (inbound_email_address) WHERE (inbound_email_address IS NOT NULL);

CREATE UNIQUE INDEX services_on_chain_idx ON public.services USING btree (on_chain_id) WHERE (on_chain_id IS NOT NULL);

CREATE INDEX sessions_expires_at_idx ON public.sessions USING btree (expires_at);

CREATE INDEX sessions_expiry_idx ON public.sessions USING btree (expires_at);

CREATE INDEX sessions_user_label_idx ON public.sessions USING btree (lower(user_label));

CREATE INDEX settlement_observations_incomplete_idx ON public.settlement_observations USING btree (state, updated_at) WHERE (state <> ALL (ARRAY['completed'::text, 'refunded'::text, 'compliance_hold'::text]));

CREATE INDEX settlement_observations_service_ref_idx ON public.settlement_observations USING btree (service_ref);

CREATE INDEX siwe_nonces_expiry_idx ON public.siwe_nonces USING btree (expires_at);

CREATE INDEX skills_active_idx ON public.skills USING btree (service_id, is_active);

CREATE INDEX standard_action_nonces_consumed_idx ON public.standard_action_nonces USING btree (consumed_at);

CREATE INDEX standard_asset_action_executions_payer_idx ON public.standard_asset_action_executions USING btree (payer, created_at DESC);

CREATE UNIQUE INDEX standard_dispatch_transaction_unique_idx ON public.standard_dispatch_claims USING btree (transaction_id) WHERE (transaction_id IS NOT NULL);

CREATE UNIQUE INDEX standard_evidence_authorization_unique_idx ON public.standard_evidence_admissions USING btree (authorization_key) WHERE (authorization_key IS NOT NULL);

CREATE UNIQUE INDEX standard_evidence_chain_locator_unique_idx ON public.standard_evidence_admissions USING btree (lower(transaction_hash), log_index) WHERE (evidence_kind = 'deposit'::text);

CREATE INDEX standard_provider_grant_nonces_consumed_idx ON public.standard_provider_grant_nonces USING btree (consumed_at);

CREATE INDEX standard_provider_quotes_dispatch_idx ON public.standard_provider_quotes USING btree (outcome_id, listing_manifest_hash, request_hash, gross_amount, issued_at DESC);

CREATE INDEX standard_reputation_outcomes_work_idx ON public.standard_reputation_outcomes USING btree (state, next_attempt_at);

CREATE INDEX standard_security_incidents_open_idx ON public.standard_security_incidents USING btree (detected_at) WHERE (resolved_at IS NULL);

CREATE INDEX standard_wallet_action_nonces_consumed_idx ON public.standard_wallet_action_nonces USING btree (consumed_at);

CREATE UNIQUE INDEX supplier_breaker_failures_key_idx ON public.supplier_breaker_failures USING btree (supplier, failure_key) WHERE (failure_key IS NOT NULL);

CREATE INDEX supplier_breaker_failures_window_idx ON public.supplier_breaker_failures USING btree (supplier, failed_at);

CREATE INDEX supplier_operations_open_idx ON public.supplier_operations USING btree (service_id, state) WHERE (state = ANY (ARRAY['intent'::text, 'ambiguous'::text]));

CREATE INDEX supplier_operations_transaction_idx ON public.supplier_operations USING btree (transaction_id) WHERE (transaction_id IS NOT NULL);

CREATE INDEX transactions_asset_idx ON public.transactions USING btree (asset_id);

CREATE INDEX transactions_created_idx ON public.transactions USING btree (created_at DESC);

CREATE INDEX transactions_customer_created_idx ON public.transactions USING btree (customer_id, created_at DESC, id DESC) WHERE (customer_id IS NOT NULL);

CREATE INDEX transactions_ephemeral_expiry_idx ON public.transactions USING btree (expires_at) WHERE ((retention_class = 'ephemeral'::text) AND (status = ANY (ARRAY['completed'::text, 'failed'::text, 'canceled'::text])));

CREATE UNIQUE INDEX transactions_ephemeral_request_unique ON public.transactions USING btree (service_id, skill_id, request_id_hash) WHERE (retention_class = 'ephemeral'::text);

CREATE INDEX transactions_service_idx ON public.transactions USING btree (service_id);

CREATE INDEX transactions_standard_asset_owner_idx ON public.transactions USING btree (asset_id, created_at DESC, id DESC) INCLUDE (standard_payer) WHERE ((asset_id IS NOT NULL) AND (standard_payer IS NOT NULL));

CREATE INDEX transactions_status_idx ON public.transactions USING btree (status);

CREATE TRIGGER compliance_governance_approvals_append_only BEFORE DELETE OR UPDATE ON public.compliance_governance_approvals FOR EACH ROW EXECUTE FUNCTION public.reject_compliance_governance_mutation();

CREATE TRIGGER escalations_evidence_immutable BEFORE UPDATE ON public.escalations FOR EACH ROW EXECUTE FUNCTION public.prevent_escalation_evidence_mutation();

CREATE TRIGGER fulfillment_hold_attempts_append_only BEFORE INSERT OR DELETE OR UPDATE ON public.fulfillment_hold_attempts FOR EACH ROW EXECUTE FUNCTION public.prevent_fulfillment_hold_attempt_mutation();

ALTER TABLE ONLY public.artifact_secrets
    ADD CONSTRAINT artifact_secrets_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id);

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_escalation_id_fkey FOREIGN KEY (escalation_id) REFERENCES public.escalations(id);

ALTER TABLE ONLY public.compliance_cases
    ADD CONSTRAINT compliance_cases_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.assets(id);

ALTER TABLE ONLY public.compliance_cases
    ADD CONSTRAINT compliance_cases_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);

ALTER TABLE ONLY public.emails_inbound
    ADD CONSTRAINT emails_inbound_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);

ALTER TABLE ONLY public.emails_inbound
    ADD CONSTRAINT emails_inbound_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id);

ALTER TABLE ONLY public.emails_inbound
    ADD CONSTRAINT emails_inbound_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);

ALTER TABLE ONLY public.emails_outbound
    ADD CONSTRAINT emails_outbound_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);

ALTER TABLE ONLY public.emails_outbound
    ADD CONSTRAINT emails_outbound_inbound_id_fkey FOREIGN KEY (inbound_id) REFERENCES public.emails_inbound(id);

ALTER TABLE ONLY public.emails_outbound
    ADD CONSTRAINT emails_outbound_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id);

ALTER TABLE ONLY public.emails_outbound
    ADD CONSTRAINT emails_outbound_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);

ALTER TABLE ONLY public.escalations
    ADD CONSTRAINT escalations_inbound_id_fkey FOREIGN KEY (inbound_id) REFERENCES public.emails_inbound(id);

ALTER TABLE ONLY public.escalations
    ADD CONSTRAINT escalations_operator_dispatch_job_id_fkey FOREIGN KEY (operator_dispatch_job_id) REFERENCES public.durable_jobs(id);

ALTER TABLE ONLY public.escalations
    ADD CONSTRAINT escalations_resolution_job_id_fkey FOREIGN KEY (resolution_job_id) REFERENCES public.durable_jobs(id);

ALTER TABLE ONLY public.escalations
    ADD CONSTRAINT escalations_snapshot_asset_id_fkey FOREIGN KEY (snapshot_asset_id) REFERENCES public.assets(id);

ALTER TABLE ONLY public.escalations
    ADD CONSTRAINT escalations_snapshot_service_id_fkey FOREIGN KEY (snapshot_service_id) REFERENCES public.services(id);

ALTER TABLE ONLY public.escalations
    ADD CONSTRAINT escalations_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.chat_threads(id);

ALTER TABLE ONLY public.escalations
    ADD CONSTRAINT escalations_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.assets(id);

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id);

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);

ALTER TABLE ONLY public.fulfillment_hold_attempts
    ADD CONSTRAINT fulfillment_hold_attempts_escalation_id_fkey FOREIGN KEY (escalation_id) REFERENCES public.escalations(id);

ALTER TABLE ONLY public.fulfillment_hold_attempts
    ADD CONSTRAINT fulfillment_hold_attempts_snapshot_service_id_fkey FOREIGN KEY (snapshot_service_id) REFERENCES public.services(id);

ALTER TABLE ONLY public.operator_chats
    ADD CONSTRAINT operator_chats_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.chat_threads(id);

ALTER TABLE ONLY public.operator_confirmation_intents
    ADD CONSTRAINT operator_confirmation_intents_approved_session_id_fkey FOREIGN KEY (approved_session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.operator_confirmation_intents
    ADD CONSTRAINT operator_confirmation_intents_consumed_turn_id_fkey FOREIGN KEY (consumed_turn_id) REFERENCES public.operator_chats(id);

ALTER TABLE ONLY public.operator_confirmation_intents
    ADD CONSTRAINT operator_confirmation_intents_origin_turn_id_fkey FOREIGN KEY (origin_turn_id) REFERENCES public.operator_chats(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.operator_confirmation_intents
    ADD CONSTRAINT operator_confirmation_intents_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.operator_confirmation_intents
    ADD CONSTRAINT operator_confirmation_intents_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);

ALTER TABLE ONLY public.protected_data_rotation_progress
    ADD CONSTRAINT protected_data_rotation_progress_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.protected_data_rotation_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.provider_chain_writes
    ADD CONSTRAINT provider_chain_writes_replacement_write_id_fkey FOREIGN KEY (replacement_write_id) REFERENCES public.provider_chain_writes(id);

ALTER TABLE ONLY public.provider_chain_writes
    ADD CONSTRAINT provider_chain_writes_supersedes_write_id_fkey FOREIGN KEY (supersedes_write_id) REFERENCES public.provider_chain_writes(id);

ALTER TABLE ONLY public.provider_quotes
    ADD CONSTRAINT provider_quotes_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES public.settlement_observations(id);

ALTER TABLE ONLY public.provider_quotes
    ADD CONSTRAINT provider_quotes_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id);

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);

ALTER TABLE ONLY public.reputation_submissions
    ADD CONSTRAINT reputation_submissions_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id);

ALTER TABLE ONLY public.reputation_submissions
    ADD CONSTRAINT reputation_submissions_provider_write_id_fkey FOREIGN KEY (provider_write_id) REFERENCES public.provider_chain_writes(id);

ALTER TABLE ONLY public.reputation_submissions
    ADD CONSTRAINT reputation_submissions_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);

ALTER TABLE ONLY public.service_rules
    ADD CONSTRAINT service_rules_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id);

ALTER TABLE ONLY public.settlement_dispositions
    ADD CONSTRAINT settlement_dispositions_escalation_id_fkey FOREIGN KEY (escalation_id) REFERENCES public.escalations(id);

ALTER TABLE ONLY public.settlement_dispositions
    ADD CONSTRAINT settlement_dispositions_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES public.settlement_observations(id);

ALTER TABLE ONLY public.settlement_dispositions
    ADD CONSTRAINT settlement_dispositions_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);

ALTER TABLE ONLY public.settlement_observations
    ADD CONSTRAINT settlement_observations_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id);

ALTER TABLE ONLY public.standard_asset_action_executions
    ADD CONSTRAINT standard_asset_action_executions_provider_asset_id_fkey FOREIGN KEY (provider_asset_id) REFERENCES public.assets(id);

ALTER TABLE ONLY public.standard_asset_action_recovery_executions
    ADD CONSTRAINT standard_asset_action_recovery_executi_action_execution_id_fkey FOREIGN KEY (action_execution_id) REFERENCES public.standard_asset_action_executions(execution_id);

ALTER TABLE ONLY public.standard_asset_action_recovery_results
    ADD CONSTRAINT standard_asset_action_recovery_results_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.standard_asset_action_executions(execution_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.standard_destructive_action_payloads
    ADD CONSTRAINT standard_destructive_action_payloads_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.standard_asset_action_executions(execution_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.standard_destructive_followup_executions
    ADD CONSTRAINT standard_destructive_followup_executio_action_execution_id_fkey FOREIGN KEY (action_execution_id) REFERENCES public.standard_asset_action_executions(execution_id);

ALTER TABLE ONLY public.standard_dispatch_claims
    ADD CONSTRAINT standard_dispatch_claims_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);

ALTER TABLE ONLY public.standard_reputation_outcomes
    ADD CONSTRAINT standard_reputation_outcomes_provider_write_id_fkey FOREIGN KEY (provider_write_id) REFERENCES public.provider_chain_writes(id);

ALTER TABLE ONLY public.standard_reputation_outcomes
    ADD CONSTRAINT standard_reputation_outcomes_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);

ALTER TABLE ONLY public.supplier_breaker_failures
    ADD CONSTRAINT supplier_breaker_failures_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);

ALTER TABLE ONLY public.supplier_circuit_breakers
    ADD CONSTRAINT supplier_circuit_breakers_escalation_id_fkey FOREIGN KEY (escalation_id) REFERENCES public.escalations(id);

ALTER TABLE ONLY public.supplier_operations
    ADD CONSTRAINT supplier_operations_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id);

ALTER TABLE ONLY public.supplier_operations
    ADD CONSTRAINT supplier_operations_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.assets(id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id);

ALTER TABLE public.provider_chain_writes ENABLE ROW LEVEL SECURITY;

CREATE POLICY provider_chain_writes_standard_runtime ON public.provider_chain_writes USING ((purpose = ANY (ARRAY['service_registration'::text, 'service_uri_update'::text, 'standard_reputation_outcome'::text]))) WITH CHECK ((purpose = ANY (ARRAY['service_registration'::text, 'service_uri_update'::text, 'standard_reputation_outcome'::text])));


SET check_function_bodies = true;

-- Durable, encrypted email attachments for supplier correspondence relay.
-- Message rows remain the delivery/idempotency anchor; ordinal preserves
-- the supplier's attachment order and makes webhook retries convergent.
ALTER TABLE emails_outbound
  ADD COLUMN reply_to TEXT
  CHECK (reply_to IS NULL OR reply_to LIKE 'daski:v1:%');

CREATE TABLE email_attachments (
    id                  UUID PRIMARY KEY,
    inbound_id          UUID REFERENCES emails_inbound(id) ON DELETE CASCADE,
    outbound_id         UUID REFERENCES emails_outbound(id) ON DELETE CASCADE,
    ordinal             INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 49),
    filename            TEXT NOT NULL CHECK (filename LIKE 'daski:v1:%'),
    content_type        TEXT NOT NULL CHECK (length(content_type) BETWEEN 1 AND 255),
    content_id          TEXT CHECK (content_id IS NULL OR content_id LIKE 'daski:v1:%'),
    content_disposition TEXT NOT NULL
      CHECK (content_disposition IN ('attachment','inline')),
    content_encrypted   TEXT NOT NULL CHECK (content_encrypted LIKE 'daski:v1:%'),
    content_sha256      TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    content_bytes       INTEGER NOT NULL CHECK (content_bytes >= 0),
    relay_eligible      BOOLEAN NOT NULL,
    quarantine_reason   TEXT CHECK (
      quarantine_reason IS NULL OR
      quarantine_reason IN (
        'unsupported_content_type',
        'invalid_content',
        'attachment_too_large'
      )
    ),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((inbound_id IS NOT NULL)::int + (outbound_id IS NOT NULL)::int = 1),
    CHECK (relay_eligible = (quarantine_reason IS NULL))
);

CREATE UNIQUE INDEX email_attachments_inbound_ordinal_idx
  ON email_attachments(inbound_id, ordinal)
  WHERE inbound_id IS NOT NULL;
CREATE UNIQUE INDEX email_attachments_outbound_ordinal_idx
  ON email_attachments(outbound_id, ordinal)
  WHERE outbound_id IS NOT NULL;
CREATE INDEX email_attachments_sha256_idx ON email_attachments(content_sha256);

-- Postmark-derived verdicts are persisted at the authenticated webhook
-- boundary. Service handlers must not reinterpret raw message headers.
ALTER TABLE emails_inbound
  ADD COLUMN postmark_sender_authenticated BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN postmark_spam_safe BOOLEAN NOT NULL DEFAULT false;

-- Durable provider-side orchestration for gateway enrollment. The exact
-- prepared response is stored before any permissionless splitter broadcast.
ALTER TABLE provider_chain_writes
  DROP CONSTRAINT provider_chain_writes_purpose_check;

ALTER TABLE provider_chain_writes
  ADD CONSTRAINT provider_chain_writes_purpose_check CHECK (purpose IN (
    'reputation_attestation',
    'refund_approval',
    'refund',
    'service_registration',
    'service_uri_update',
    'nonce_cancel',
    'standard_reputation_outcome',
    'splitter_deployment'
  ));

DROP POLICY IF EXISTS provider_chain_writes_standard_runtime
  ON provider_chain_writes;

CREATE POLICY provider_chain_writes_standard_runtime
  ON provider_chain_writes
  USING (purpose IN (
    'service_registration',
    'service_uri_update',
    'standard_reputation_outcome',
    'splitter_deployment'
  ))
  WITH CHECK (purpose IN (
    'service_registration',
    'service_uri_update',
    'standard_reputation_outcome',
    'splitter_deployment'
  ));

CREATE TABLE provider_gateway_registrations (
  id UUID PRIMARY KEY,
  gateway_origin TEXT NOT NULL,
  service_row_id UUID NOT NULL REFERENCES services(id),
  service_id BYTEA NOT NULL CHECK (octet_length(service_id) = 32),
  card_contract_hash BYTEA NOT NULL CHECK (octet_length(card_contract_hash) = 32),
  state TEXT NOT NULL CHECK (state IN (
    'INTENT_READY','PREPARED','BROADCAST','EVIDENCE_SUBMITTED','ACTIVE','ATTENTION'
  )),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  gateway_registration_id UUID,
  canonical_intent JSONB NOT NULL,
  prepared_response JSONB,
  canonical_evidence JSONB,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gateway_origin, service_id),
  UNIQUE (gateway_origin, idempotency_key)
);

CREATE INDEX provider_gateway_registrations_state_idx
  ON provider_gateway_registrations(state, updated_at);

CREATE TABLE provider_gateway_splitter_writes (
  listing_id UUID PRIMARY KEY,
  gateway_registration_local_id UUID NOT NULL
    REFERENCES provider_gateway_registrations(id),
  expected_splitter_address TEXT NOT NULL
    CHECK (expected_splitter_address ~ '^0x[0-9a-f]{40}$'),
  canonical_transaction JSONB NOT NULL,
  provider_write_id UUID REFERENCES provider_chain_writes(id),
  transaction_hash TEXT
    CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN (
    'PREPARED','BROADCAST','CONFIRMED','REVERTED','ATTENTION'
  )),
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX provider_gateway_splitter_writes_registration_idx
  ON provider_gateway_splitter_writes(gateway_registration_local_id, state);

-- Append-only provider runtime catalog: one immutable listing version per
-- admitted runtime commitment, with one active head per service skill.
CREATE TABLE provider_runtime_listing_versions (
  id UUID PRIMARY KEY,
  gateway_origin TEXT NOT NULL,
  service_id BYTEA NOT NULL CHECK (octet_length(service_id) = 32),
  skill_id TEXT NOT NULL CHECK (length(skill_id) BETWEEN 1 AND 96),
  listing_id UUID NOT NULL,
  listing_key BYTEA NOT NULL CHECK (octet_length(listing_key) = 32),
  payment_required BOOLEAN NOT NULL,
  runtime_commitment_hash BYTEA NOT NULL CHECK (
    octet_length(runtime_commitment_hash) = 32
  ),
  runtime_commitment JSONB NOT NULL,
  bundle JSONB NOT NULL,
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ,
  UNIQUE (gateway_origin, service_id, skill_id, runtime_commitment_hash)
);

CREATE UNIQUE INDEX provider_runtime_listing_heads
  ON provider_runtime_listing_versions(gateway_origin, service_id, skill_id)
  WHERE superseded_at IS NULL;
