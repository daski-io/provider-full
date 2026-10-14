-- A database-enforced barrier against processes built for an older schema.
-- Earlier images apply only the migrations they know and silently ignore
-- the rest, so no check inside a new image can stop an old one. Instead,
-- every statement that writes a core table must come from a session that
-- declared a runtime epoch at least the schema's minimum (SET
-- daski.runtime_epoch). Images from this release declare epoch 1 on every
-- connection; earlier images declare none, so their first write fails
-- before it changes anything: they cannot register services, admit or
-- transition orders, claim jobs, sweep tasks, journal supplier calls or
-- send mail. Reads still work. Only the migration ledgers stay writable.
-- This is a compatibility control, not protection from a credential holder,
-- who can set the marker by hand. A later migration that breaks this
-- release's runtimes replaces provider_minimum_runtime_epoch(), and every
-- later migration that creates a table guards it the same way.
CREATE FUNCTION public.provider_minimum_runtime_epoch() RETURNS integer
    LANGUAGE sql STABLE
    AS $$ SELECT 1 $$;

CREATE FUNCTION public.provider_require_runtime_epoch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  marker text := current_setting('daski.runtime_epoch', true);
BEGIN
  IF marker IS NULL OR marker !~ '^[0-9]{1,6}$'
    OR marker::integer < public.provider_minimum_runtime_epoch()
  THEN
    RAISE EXCEPTION 'this process predates the database schema and may not write %', TG_TABLE_NAME
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Run a provider image that supports the migrated schema.';
  END IF;
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  guarded text;
BEGIN
  FOREACH guarded IN ARRAY ARRAY[
    'artifact_secrets', 'assets', 'auth_rate_limit_buckets', 'blocked_identities', 'chat_threads',
    'compliance_cases', 'compliance_governance_approvals', 'compliance_sweep_runs', 'customers',
    'durable_jobs', 'email_attachments', 'emails_inbound', 'emails_outbound', 'escalations',
    'events', 'fulfillment_hold_attempts', 'legal_holds', 'operator_chats',
    'operator_config_revisions', 'operator_confirmation_intents', 'payments',
    'protected_data_rotation_progress', 'protected_data_rotation_roles',
    'protected_data_rotation_runs', 'provider_chain_writes', 'provider_gateway_registrations',
    'provider_gateway_splitter_writes', 'provider_quotes', 'provider_runtime_listing_versions',
    'provider_signer_cursors', 'push_subscriptions', 'rate_limit_buckets',
    'reputation_submissions', 'service_rules', 'services', 'sessions', 'settlement_dispositions',
    'settlement_observations', 'siwe_nonces', 'skills', 'standard_action_nonces',
    'standard_admitted_action_definitions', 'standard_asset_action_executions',
    'standard_asset_action_recovery_executions', 'standard_asset_action_recovery_results',
    'standard_asset_rate_buckets', 'standard_destructive_action_payloads',
    'standard_destructive_followup_executions', 'standard_dispatch_claims',
    'standard_evidence_admissions', 'standard_lifecycle_actions', 'standard_provider_grant_nonces',
    'standard_provider_quotes', 'standard_reputation_outcomes', 'standard_security_incidents',
    'standard_support_receipts', 'standard_terminal_evidence', 'standard_terminal_results',
    'standard_wallet_action_nonces', 'supplier_breaker_failures', 'supplier_circuit_breakers',
    'supplier_configs', 'supplier_operations', 'transactions'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION public.provider_require_runtime_epoch()',
      guarded || '_runtime_epoch', guarded);
  END LOOP;
END;
$$;
