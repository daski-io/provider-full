-- A buyer's signed support request is deduplicated by order, payer and the
-- gateway's business requestId, bound to its content hash. The receipt keeps
-- the message id, the human Review it opened or joined and its acceptance
-- time, so a retry under a fresh authorization returns the original receipt.
-- The message itself is a protected customer event subject to ordinary
-- retention; the receipt deliberately holds no key to it.
CREATE TABLE public.standard_support_receipts (
    transaction_id text NOT NULL,
    payer text NOT NULL,
    request_id text NOT NULL,
    request_hash bytea NOT NULL,
    message_id uuid NOT NULL,
    review_id uuid NOT NULL,
    accepted_at timestamp with time zone NOT NULL,
    CONSTRAINT standard_support_receipts_payer_check CHECK ((payer ~ '^0x[0-9a-f]{40}$'::text)),
    CONSTRAINT standard_support_receipts_request_id_check CHECK ((request_id ~ '^[A-Za-z0-9_-]{1,128}$'::text)),
    CONSTRAINT standard_support_receipts_request_hash_check CHECK ((octet_length(request_hash) = 32))
);

ALTER TABLE ONLY public.standard_support_receipts
    ADD CONSTRAINT standard_support_receipts_pkey PRIMARY KEY (transaction_id, payer, request_id);
ALTER TABLE ONLY public.standard_support_receipts
    ADD CONSTRAINT standard_support_receipts_message_id_key UNIQUE (message_id);
ALTER TABLE ONLY public.standard_support_receipts
    ADD CONSTRAINT standard_support_receipts_transaction_id_fkey
    FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);
ALTER TABLE ONLY public.standard_support_receipts
    ADD CONSTRAINT standard_support_receipts_review_id_fkey
    FOREIGN KEY (review_id) REFERENCES public.escalations(id);

CREATE FUNCTION public.prevent_standard_support_receipt_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'standard support receipts are append-only'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER standard_support_receipts_append_only
    BEFORE DELETE OR UPDATE ON public.standard_support_receipts
    FOR EACH ROW EXECUTE FUNCTION public.prevent_standard_support_receipt_change();

-- operations.support names the order's current support Review. Whatever path
-- closes that Review, the projection reports it closed under a higher
-- revision in the same transaction.
CREATE FUNCTION public.close_standard_order_support() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.review_kind = 'standard_order_support'
    AND NEW.status IS DISTINCT FROM OLD.status
    AND NEW.status = ANY (ARRAY['resolved'::text, 'rejected'::text, 'approved'::text, 'edited'::text])
  THEN
    UPDATE public.standard_dispatch_claims
       SET operations_projection = jsonb_set(operations_projection, '{support,status}', '"closed"'::jsonb),
           operations_revision = operations_revision + 1
     WHERE operations_projection #>> '{support,reviewId}' = NEW.id::text
       AND operations_projection #>> '{support,status}' = 'open';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER escalations_close_standard_order_support
    AFTER UPDATE OF status ON public.escalations
    FOR EACH ROW EXECUTE FUNCTION public.close_standard_order_support();
