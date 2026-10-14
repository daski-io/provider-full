-- Every dispatch and status answer carries an operations observation. Its
-- semantic projection (fulfillment, support, recovery) and monotonic revision
-- are persisted with the claim; each answer stamps a fresh observedAt from the
-- database clock and is signed for that request only. Content that stays
-- all-null keeps revision 0 for the life of the order.
ALTER TABLE public.standard_dispatch_claims
    ADD COLUMN operations_revision bigint DEFAULT 0 NOT NULL,
    ADD COLUMN operations_projection jsonb
        DEFAULT '{"fulfillment": null, "recovery": null, "support": null}'::jsonb NOT NULL,
    ADD CONSTRAINT standard_dispatch_claims_operations_revision_check
        CHECK ((operations_revision >= 0)),
    ADD CONSTRAINT standard_dispatch_claims_operations_projection_check
        CHECK (((jsonb_typeof(operations_projection) = 'object'::text)
          AND (operations_projection ?& ARRAY['fulfillment'::text, 'recovery'::text, 'support'::text])));

-- One revision names exactly one semantic projection: changed content needs a
-- higher revision, unchanged content keeps its revision, and a revision never
-- decreases. The gateway rejects a second body under a revision it stored.
CREATE FUNCTION public.guard_standard_order_operations_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.operations_revision < OLD.operations_revision
    OR (NEW.operations_projection IS DISTINCT FROM OLD.operations_projection
        AND NEW.operations_revision <= OLD.operations_revision)
    OR (NEW.operations_projection IS NOT DISTINCT FROM OLD.operations_projection
        AND NEW.operations_revision <> OLD.operations_revision)
  THEN
    RAISE EXCEPTION 'standard order operations revision does not match its projection'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER standard_dispatch_claims_operations_revision
    BEFORE UPDATE OF operations_revision, operations_projection ON public.standard_dispatch_claims
    FOR EACH ROW EXECUTE FUNCTION public.guard_standard_order_operations_revision();
