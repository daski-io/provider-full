-- Buyer input and cancellation carry no business request id, so each is
-- identified by its admitted task and its own content: a cancellation once
-- per order, an input by the hash of its request. A claim is taken under a
-- lease before the service is called and committed in the same transaction
-- as the task state it produced, so a retry under a fresh gateway grant or
-- payer nonce returns the committed outcome instead of repeating it. A claim
-- whose attempt failed before any effect is released; one whose outcome is
-- uncertain stays claimed until a later attempt reconciles it.
CREATE TABLE public.standard_lifecycle_actions (
    transaction_id text NOT NULL,
    action text NOT NULL,
    identity_hash bytea NOT NULL,
    request_hash bytea NOT NULL,
    state text NOT NULL,
    attempts integer DEFAULT 1 NOT NULL,
    lease_expires_at timestamp with time zone,
    outcome_state text,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    committed_at timestamp with time zone,
    CONSTRAINT standard_lifecycle_actions_action_check CHECK ((action = ANY (ARRAY['input'::text, 'cancel'::text]))),
    CONSTRAINT standard_lifecycle_actions_identity_hash_check CHECK ((octet_length(identity_hash) = 32)),
    CONSTRAINT standard_lifecycle_actions_request_hash_check CHECK ((octet_length(request_hash) = 32)),
    CONSTRAINT standard_lifecycle_actions_state_check CHECK ((state = ANY (ARRAY['claimed'::text, 'committed'::text]))),
    CONSTRAINT standard_lifecycle_actions_attempts_check CHECK ((attempts >= 1)),
    CONSTRAINT standard_lifecycle_actions_outcome_check CHECK ((((state = 'committed'::text)
      = ((committed_at IS NOT NULL) AND (outcome_state IS NOT NULL)))
      AND ((state = 'claimed'::text) = (lease_expires_at IS NOT NULL))))
);

ALTER TABLE ONLY public.standard_lifecycle_actions
    ADD CONSTRAINT standard_lifecycle_actions_pkey PRIMARY KEY (transaction_id, action, identity_hash);
ALTER TABLE ONLY public.standard_lifecycle_actions
    ADD CONSTRAINT standard_lifecycle_actions_transaction_id_fkey
    FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);

-- A committed outcome is permanent.
CREATE FUNCTION public.guard_standard_lifecycle_action() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.state = 'committed' THEN
    RAISE EXCEPTION 'committed standard lifecycle actions are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
    OR NEW.action IS DISTINCT FROM OLD.action OR NEW.identity_hash IS DISTINCT FROM OLD.identity_hash
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash)
  THEN
    RAISE EXCEPTION 'standard lifecycle action identity is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER standard_lifecycle_actions_guard
    BEFORE DELETE OR UPDATE ON public.standard_lifecycle_actions
    FOR EACH ROW EXECUTE FUNCTION public.guard_standard_lifecycle_action();
