-- Readiness quotes bind the gateway's exact quote payer (lowercase, or NULL
-- for a payer-unbound readiness check) and their pricing mode, so dispatch
-- verifies the persisted quote for fixed and dynamic listings alike. Rows
-- written by earlier releases were only ever dynamic quotes without a payer.
ALTER TABLE public.standard_provider_quotes
    ADD COLUMN payer text,
    ADD COLUMN pricing_mode text DEFAULT 'dynamic'::text NOT NULL;

ALTER TABLE public.standard_provider_quotes
    ALTER COLUMN pricing_mode DROP DEFAULT,
    ADD CONSTRAINT standard_provider_quotes_payer_check
        CHECK (((payer IS NULL) OR (payer ~ '^0x[0-9a-f]{40}$'::text))),
    ADD CONSTRAINT standard_provider_quotes_pricing_mode_check
        CHECK ((pricing_mode = ANY (ARRAY['fixed'::text, 'dynamic'::text])));

-- The provider quote each claim was admitted under. NULL only for claims
-- admitted before every pricing mode persisted its quote; the foreign key
-- keeps an admitted quote from disappearing while its order exists.
ALTER TABLE public.standard_dispatch_claims
    ADD COLUMN provider_quote_hash bytea,
    ADD CONSTRAINT standard_dispatch_claims_provider_quote_hash_check
        CHECK (((provider_quote_hash IS NULL) OR (octet_length(provider_quote_hash) = 32))),
    ADD CONSTRAINT standard_dispatch_claims_provider_quote_hash_fkey
        FOREIGN KEY (provider_quote_hash) REFERENCES public.standard_provider_quotes(quote_hash);

-- Quote-time capacity counts open paid work per listing version.
CREATE INDEX transactions_standard_open_listing_idx ON public.transactions
    USING btree (standard_listing_manifest_hash)
    WHERE ((standard_order_id IS NOT NULL)
       AND (status = ANY (ARRAY['submitted'::text, 'working'::text, 'input-required'::text])));
