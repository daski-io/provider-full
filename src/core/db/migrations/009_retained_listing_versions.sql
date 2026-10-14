-- Every promoted runtime listing version stays resolvable by its commitment
-- hash for the life of its orders: dispatch, workers, lifecycle reads and
-- terminal evidence resolve the version an order was sold under, never the
-- current head. A version leaves dispatch servicing only through retirement,
-- which records the verified gateway receipt that its dispatch obligations
-- ended; reads of its orders are never retired.
ALTER TABLE public.provider_runtime_listing_versions
    ADD COLUMN retired_at timestamp with time zone,
    ADD COLUMN retirement jsonb,
    ADD CONSTRAINT provider_runtime_listing_versions_retirement_check
        CHECK ((((retired_at IS NULL) = (retirement IS NULL))
          AND ((retirement IS NULL) OR (jsonb_typeof(retirement) = 'object'::text)))),
    -- A retired version is never a head again.
    ADD CONSTRAINT provider_runtime_listing_versions_retired_superseded_check
        CHECK (((retired_at IS NULL) OR (superseded_at IS NOT NULL)));

CREATE INDEX provider_runtime_listing_versions_commitment_idx
    ON public.provider_runtime_listing_versions USING btree (runtime_commitment_hash);

-- The obligation inventory counts every order, quote and claim of a version.
CREATE INDEX transactions_standard_listing_idx ON public.transactions
    USING btree (standard_listing_manifest_hash) WHERE (standard_listing_manifest_hash IS NOT NULL);
CREATE INDEX standard_provider_quotes_listing_idx ON public.standard_provider_quotes
    USING btree (listing_manifest_hash, valid_before);
CREATE INDEX standard_dispatch_claims_provider_quote_idx ON public.standard_dispatch_claims
    USING btree (provider_quote_hash) WHERE (provider_quote_hash IS NOT NULL);

-- A version's admitted content never changes and its row is never removed;
-- a retired version stays retired and superseded.
CREATE FUNCTION public.guard_provider_runtime_listing_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'runtime listing versions are retained'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.gateway_origin IS DISTINCT FROM OLD.gateway_origin
    OR NEW.service_id IS DISTINCT FROM OLD.service_id
    OR NEW.skill_id IS DISTINCT FROM OLD.skill_id
    OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
    OR NEW.listing_key IS DISTINCT FROM OLD.listing_key
    OR NEW.payment_required IS DISTINCT FROM OLD.payment_required
    OR NEW.runtime_commitment_hash IS DISTINCT FROM OLD.runtime_commitment_hash
    OR NEW.runtime_commitment IS DISTINCT FROM OLD.runtime_commitment
    OR NEW.bundle IS DISTINCT FROM OLD.bundle
    OR NEW.promoted_at IS DISTINCT FROM OLD.promoted_at
  THEN
    RAISE EXCEPTION 'runtime listing version content is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.retired_at IS NOT NULL AND (
    NEW.retired_at IS DISTINCT FROM OLD.retired_at
    OR NEW.retirement IS DISTINCT FROM OLD.retirement
    OR NEW.superseded_at IS NULL)
  THEN
    RAISE EXCEPTION 'a retired runtime listing version cannot be changed or reactivated'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_runtime_listing_versions_guard
    BEFORE DELETE OR UPDATE ON public.provider_runtime_listing_versions
    FOR EACH ROW EXECUTE FUNCTION public.guard_provider_runtime_listing_version();

-- The activation revision: every write to the catalog (promotion, supersede,
-- retirement) advances it. A sequence never makes two promotions conflict;
-- a rolled-back write may advance it, which only causes a re-validation.
CREATE SEQUENCE public.provider_catalog_revision AS bigint START WITH 1 MINVALUE 1;

CREATE FUNCTION public.advance_provider_catalog_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM nextval('public.provider_catalog_revision');
  RETURN NULL;
END;
$$;

CREATE TRIGGER provider_runtime_listing_versions_revision
    AFTER INSERT OR UPDATE ON public.provider_runtime_listing_versions
    FOR EACH STATEMENT EXECUTE FUNCTION public.advance_provider_catalog_revision();

-- The admission fence for every writer, this release or another: a new
-- standard order or provider quote locks the versions of its commitment hash
-- and is refused for a retired one. Retirement locks the same rows before it
-- counts obligations, so an admission either commits first and is counted,
-- or waits and is refused.
CREATE FUNCTION public.assert_standard_listing_version_open() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  manifest bytea;
  version_row record;
BEGIN
  IF TG_TABLE_NAME = 'transactions' THEN
    manifest := NEW.standard_listing_manifest_hash;
  ELSE
    manifest := NEW.listing_manifest_hash;
  END IF;
  IF manifest IS NULL THEN
    RETURN NEW;
  END IF;
  FOR version_row IN
    SELECT retired_at FROM public.provider_runtime_listing_versions
     WHERE runtime_commitment_hash = manifest
     ORDER BY id
     FOR SHARE
  LOOP
    IF version_row.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'standard listing version is retired'
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transactions_standard_listing_version_open
    BEFORE INSERT ON public.transactions
    FOR EACH ROW WHEN ((NEW.standard_listing_manifest_hash IS NOT NULL))
    EXECUTE FUNCTION public.assert_standard_listing_version_open();

CREATE TRIGGER standard_provider_quotes_listing_version_open
    BEFORE INSERT ON public.standard_provider_quotes
    FOR EACH ROW EXECUTE FUNCTION public.assert_standard_listing_version_open();

-- Every signed asset-action definition this provider ever admitted, kept by
-- its hash so an execution accepted under it is completed under it after the
-- catalog moves to a new epoch. Rows are verified when written and re-verified
-- when read; they are never changed or removed.
CREATE TABLE public.standard_admitted_action_definitions (
    action_definition_hash bytea NOT NULL,
    service_slug text NOT NULL,
    action_id text NOT NULL,
    definition jsonb NOT NULL,
    action_catalog_hash bytea NOT NULL,
    admitted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT standard_admitted_action_definitions_hash_check
        CHECK ((octet_length(action_definition_hash) = 32)),
    CONSTRAINT standard_admitted_action_definitions_catalog_check
        CHECK ((octet_length(action_catalog_hash) = 32)),
    CONSTRAINT standard_admitted_action_definitions_definition_check
        CHECK ((jsonb_typeof(definition) = 'object'::text))
);

ALTER TABLE ONLY public.standard_admitted_action_definitions
    ADD CONSTRAINT standard_admitted_action_definitions_pkey PRIMARY KEY (action_definition_hash);

CREATE FUNCTION public.prevent_standard_admitted_action_definition_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'admitted asset action definitions are immutable'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER standard_admitted_action_definitions_immutable
    BEFORE DELETE OR UPDATE ON public.standard_admitted_action_definitions
    FOR EACH ROW EXECUTE FUNCTION public.prevent_standard_admitted_action_definition_change();
