-- An admitted order keeps the deadlines it was sold with. The dispatch
-- deadline is the gateway's quote and dispatch clock: it bounds only when a
-- new claim may commit. The fulfillment duration starts at durable
-- acceptance and marks work overdue; it never makes accepted or ambiguous
-- work terminal on its own. Both are set once at admission and never change.
ALTER TABLE public.standard_dispatch_claims
    ADD COLUMN admitted_dispatch_seconds integer,
    ADD COLUMN admitted_fulfillment_seconds integer,
    ADD COLUMN fulfillment_overdue_at timestamp with time zone,
    ADD CONSTRAINT standard_dispatch_claims_admitted_dispatch_seconds_check
        CHECK (((admitted_dispatch_seconds IS NULL)
          OR ((admitted_dispatch_seconds >= 30) AND (admitted_dispatch_seconds <= 86400)))),
    ADD CONSTRAINT standard_dispatch_claims_admitted_fulfillment_seconds_check
        CHECK (((admitted_fulfillment_seconds IS NULL)
          OR ((admitted_fulfillment_seconds >= 30) AND (admitted_fulfillment_seconds <= 31536000))));

-- Claims admitted by earlier releases take their durations from the only
-- authenticated record of them: the published contract of the listing
-- version their task names, with the gateway's sealed defaults where it
-- states none. A claim whose version is unknown, or whose contract states a
-- malformed duration, keeps NULL; nothing is guessed.
CREATE FUNCTION public.standard_contract_deadline(deadlines jsonb, field text, fallback integer, maximum integer)
    RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    WHEN deadlines IS NULL OR jsonb_typeof(deadlines) <> 'object' OR NOT (deadlines ? field) THEN fallback
    WHEN jsonb_typeof(deadlines -> field) = 'number'
      AND (deadlines ->> field) ~ '^[0-9]{2,8}$'
      AND (deadlines ->> field)::integer BETWEEN 30 AND maximum
      THEN (deadlines ->> field)::integer
    ELSE NULL
  END
$$;

UPDATE public.standard_dispatch_claims c
   SET admitted_dispatch_seconds = public.standard_contract_deadline(v.deadlines, 'dispatchSeconds', 300, 86400),
       admitted_fulfillment_seconds =
         public.standard_contract_deadline(v.deadlines, 'fulfillmentSeconds', 2592000, 31536000)
  FROM public.transactions t
  CROSS JOIN LATERAL (
    SELECT versions.bundle -> 'skillContract' -> 'contract' -> 'deadlines' AS deadlines
      FROM public.provider_runtime_listing_versions versions
     WHERE versions.runtime_commitment_hash = t.standard_listing_manifest_hash
     ORDER BY versions.promoted_at, versions.id
     LIMIT 1
  ) v
 WHERE t.id = c.transaction_id
   AND c.admitted_fulfillment_seconds IS NULL;

CREATE FUNCTION public.guard_standard_claim_admitted_clocks() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (OLD.admitted_dispatch_seconds IS NOT NULL
        AND NEW.admitted_dispatch_seconds IS DISTINCT FROM OLD.admitted_dispatch_seconds)
    OR (OLD.admitted_fulfillment_seconds IS NOT NULL
        AND NEW.admitted_fulfillment_seconds IS DISTINCT FROM OLD.admitted_fulfillment_seconds)
    OR (OLD.fulfillment_overdue_at IS NOT NULL
        AND NEW.fulfillment_overdue_at IS DISTINCT FROM OLD.fulfillment_overdue_at)
  THEN
    RAISE EXCEPTION 'standard order admitted deadlines are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER standard_dispatch_claims_admitted_clocks
    BEFORE UPDATE OF admitted_dispatch_seconds, admitted_fulfillment_seconds, fulfillment_overdue_at
    ON public.standard_dispatch_claims
    FOR EACH ROW EXECUTE FUNCTION public.guard_standard_claim_admitted_clocks();

-- A durable job may require one executable definition: only a worker whose
-- build can run that contract claims it. Earlier runtimes never consume the
-- queues that set it.
ALTER TABLE public.durable_jobs
    ADD COLUMN required_capability text,
    ADD CONSTRAINT durable_jobs_required_capability_check
        CHECK (((required_capability IS NULL) OR (required_capability ~ '^0x[0-9a-f]{64}$'::text)));
