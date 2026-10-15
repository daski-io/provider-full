-- Core migrations 012 and 013 created asset_owner_overrides and
-- asset_delivery_admissions without the runtime epoch statement trigger
-- that every core table carries (core migration 011). Without it, a session
-- that declared no runtime epoch, or one below the schema's minimum, could
-- still write an owner override or a delivery admission once a later
-- migration raises that minimum. Both tables now refuse insert, update,
-- delete and truncate statements from such a session, like every other
-- core table.
CREATE TRIGGER asset_owner_overrides_runtime_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON asset_owner_overrides FOR EACH STATEMENT EXECUTE FUNCTION public.provider_require_runtime_epoch();
CREATE TRIGGER asset_delivery_admissions_runtime_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON asset_delivery_admissions FOR EACH STATEMENT EXECUTE FUNCTION public.provider_require_runtime_epoch();
