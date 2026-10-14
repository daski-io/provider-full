-- Accepted work is keyed by gateway audience and order, with immutable
-- request, payer, provider-quote and dispatch bindings. A claim is never
-- removed or rebound: a different envelope must never replace admitted work,
-- and an exact replay must keep finding the original task.
CREATE FUNCTION public.prevent_standard_dispatch_claim_rebinding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'standard dispatch claims are retained'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.gateway_audience IS DISTINCT FROM OLD.gateway_audience
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.dispatch_nonce IS DISTINCT FROM OLD.dispatch_nonce
    OR NEW.dispatch_hash IS DISTINCT FROM OLD.dispatch_hash
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.payer IS DISTINCT FROM OLD.payer
    OR NEW.provider_quote_hash IS DISTINCT FROM OLD.provider_quote_hash
    OR (OLD.transaction_id IS NOT NULL AND NEW.transaction_id IS DISTINCT FROM OLD.transaction_id)
  THEN
    RAISE EXCEPTION 'standard dispatch claim bindings are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER standard_dispatch_claims_bindings_immutable
    BEFORE DELETE OR UPDATE ON public.standard_dispatch_claims
    FOR EACH ROW EXECUTE FUNCTION public.prevent_standard_dispatch_claim_rebinding();
