-- One owner authority for every asset. An asset_owner_overrides row is
-- authoritative when present; otherwise the owner is the payer of the most
-- recent standard order linked to the asset, at version 0
-- (src/core/db/queries/assetOwnership.ts). The starter ships no path that
-- changes an owner, so the table stays empty unless a fork adds one, and
-- that path must follow the complete fencing sequence in
-- docs/architecture.md: under the asset owner fence, refuse while owner-only
-- work or a delivery admission is live, write the next version, cancel
-- staged actions and revoke open delivery admissions in one transaction.
-- transactions.standard_payer is never rewritten.
CREATE TABLE public.asset_owner_overrides (
    asset_id uuid NOT NULL,
    payer text NOT NULL,
    version integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asset_owner_overrides_payer_check CHECK ((payer ~ '^0x[0-9a-f]{40}$'::text)),
    CONSTRAINT asset_owner_overrides_version_check CHECK ((version >= 1))
);

ALTER TABLE ONLY public.asset_owner_overrides
    ADD CONSTRAINT asset_owner_overrides_pkey PRIMARY KEY (asset_id);
ALTER TABLE ONLY public.asset_owner_overrides
    ADD CONSTRAINT asset_owner_overrides_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.assets(id);
CREATE INDEX asset_owner_overrides_payer_idx ON public.asset_owner_overrides USING btree (payer);

-- Every asset-action execution records the owner it was admitted under, and
-- the result boundaries compare it with the current owner before anything
-- is persisted or released. Executions that already exist were admitted for
-- their own verified payer while ownership could only be derived, which is
-- version 0 by definition; a missing value is otherwise a broken row.
ALTER TABLE ONLY public.standard_asset_action_executions
    ADD COLUMN admitted_owner text,
    ADD COLUMN admitted_owner_version integer;
UPDATE public.standard_asset_action_executions
   SET admitted_owner = lower(payer), admitted_owner_version = 0
 WHERE admitted_owner IS NULL;
ALTER TABLE ONLY public.standard_asset_action_executions
    ALTER COLUMN admitted_owner SET NOT NULL,
    ALTER COLUMN admitted_owner_version SET NOT NULL,
    ADD CONSTRAINT standard_asset_action_executions_admitted_owner_check
        CHECK (((admitted_owner ~ '^0x[0-9a-f]{40}$'::text) AND (admitted_owner_version >= 0)));

-- A task doing owner-only work on an existing asset (an owner-only paid
-- order, an asset action) records the same admission; a task without one
-- (a first-time provisioning, an any-payer order) carries neither column.
ALTER TABLE ONLY public.transactions
    ADD COLUMN admitted_owner text,
    ADD COLUMN admitted_owner_version integer,
    ADD CONSTRAINT transactions_admitted_owner_check CHECK ((((admitted_owner IS NULL) AND (admitted_owner_version IS NULL))
      OR ((admitted_owner ~ '^0x[0-9a-f]{40}$'::text) AND (admitted_owner_version >= 0) AND (asset_id IS NOT NULL))));
