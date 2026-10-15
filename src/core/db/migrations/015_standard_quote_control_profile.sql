-- The first dispatch of a paid order carries the provider control profile
-- its checkout snapshot committed, which can be one the provider has since
-- rotated away from: the gateway retries a first dispatch long after the
-- quote expired. Each readiness quote records the control profile it was
-- issued under, so the compatibility check can name a profile that quotes
-- of an unretired listing version may still be dispatched under but the
-- deployment no longer accepts. NULL for quotes of earlier releases, which
-- recorded none.
ALTER TABLE public.standard_provider_quotes
    ADD COLUMN provider_control_profile_hash bytea,
    ADD CONSTRAINT standard_provider_quotes_control_profile_hash_check
        CHECK (((provider_control_profile_hash IS NULL) OR (octet_length(provider_control_profile_hash) = 32)));
