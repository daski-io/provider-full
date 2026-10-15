-- A provider quote is owed only while the gateway may still make a first
-- dispatch for it. The protocol never signs one more than 30 days
-- (2,592,000 s) after the quote's validBefore, and a dispatch envelope lives
-- at most a day, so no claim can name a quote once 2,678,400 s have passed
-- since its own valid_before. Until then the quote is kept for any order that
-- may still be paid with it. Whoever deletes, a quote goes only once that
-- window has passed and no dispatch claim names it: a task names its quote
-- only through its claim, and claims are never deleted (core migration 005).
-- The index keeps the bounded retention prune to the lapsed quotes.
CREATE FUNCTION public.guard_standard_provider_quote_deletion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.valid_before >= now() - make_interval(secs => 2678400) THEN
    RAISE EXCEPTION 'standard provider quotes are retained for their first-dispatch window'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.standard_dispatch_claims c WHERE c.provider_quote_hash = OLD.quote_hash
  ) THEN
    RAISE EXCEPTION 'standard provider quotes named by a dispatch claim are retained'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER standard_provider_quotes_retained
    BEFORE DELETE ON public.standard_provider_quotes
    FOR EACH ROW EXECUTE FUNCTION public.guard_standard_provider_quote_deletion();

CREATE INDEX standard_provider_quotes_valid_before_idx ON public.standard_provider_quotes
    USING btree (valid_before);
