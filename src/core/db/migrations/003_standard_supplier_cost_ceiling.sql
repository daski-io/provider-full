-- A standard order's supplier-cost ceiling is bound at dispatch admission
-- from its persisted provider quote. Every later attempt, retry, input or
-- cancellation must spend under that same ceiling, so no update may add,
-- change or remove it once the order exists.
CREATE FUNCTION public.prevent_standard_supplier_cost_ceiling_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.standard_order_id IS NOT NULL
    AND (NEW.metadata -> 'supplier_cost_ceiling') IS DISTINCT FROM (OLD.metadata -> 'supplier_cost_ceiling')
  THEN
    RAISE EXCEPTION 'standard order supplier cost ceiling is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transactions_standard_supplier_cost_ceiling_immutable
    BEFORE UPDATE OF metadata ON public.transactions
    FOR EACH ROW EXECUTE FUNCTION public.prevent_standard_supplier_cost_ceiling_change();
