-- Delivering information about an asset to its owner (an email, a protected
-- document, a notice) is owner-only work. Core delivers none itself; a
-- service that does admits each delivery under the asset owner fence for the
-- owner it addresses (src/core/standardRail/assetDeliveryAdmission.ts),
-- sends outside every lock, and renews the admission under the fence
-- immediately before the bounded outbound call. The renewal refuses when the
-- admission was revoked or finished or the owner or its version changed.
-- Admission and renewal times are statement times taken once the fence is
-- held. An owner change a fork adds must count a live admission (open,
-- unrevoked, renewed within the bound) as active work and revoke every open
-- admission of the asset in its own fenced transaction. Rows are lock
-- bookkeeping, not evidence.
CREATE TABLE public.asset_delivery_admissions (
    id uuid NOT NULL,
    asset_id uuid NOT NULL,
    purpose text NOT NULL,
    admitted_owner text NOT NULL,
    admitted_owner_version integer NOT NULL,
    admitted_at timestamp with time zone NOT NULL,
    renewed_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    finished_at timestamp with time zone,
    outcome text,
    CONSTRAINT asset_delivery_admissions_purpose_check CHECK ((purpose ~ '^[a-z][a-z0-9_.:-]{0,95}$'::text)),
    CONSTRAINT asset_delivery_admissions_owner_check
        CHECK (((admitted_owner ~ '^0x[0-9a-f]{40}$'::text) AND (admitted_owner_version >= 0))),
    CONSTRAINT asset_delivery_admissions_outcome_check CHECK ((((finished_at IS NULL) = (outcome IS NULL))
      AND ((outcome IS NULL) OR (outcome = ANY (ARRAY['delivered'::text, 'refused'::text, 'failed'::text])))))
);

ALTER TABLE ONLY public.asset_delivery_admissions
    ADD CONSTRAINT asset_delivery_admissions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.asset_delivery_admissions
    ADD CONSTRAINT asset_delivery_admissions_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.assets(id);
CREATE INDEX asset_delivery_admissions_open_idx ON public.asset_delivery_admissions USING btree (asset_id)
    WHERE ((finished_at IS NULL) AND (revoked_at IS NULL));
