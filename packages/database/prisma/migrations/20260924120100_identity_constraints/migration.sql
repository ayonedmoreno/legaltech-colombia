-- Manual migration: constraints Prisma cannot express (see DATABASE_SPEC.md v0.1).

-- Emails are stored normalized (lowercase, trimmed) by the application; enforce it in the database.
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_normalized_chk" CHECK ("email" = lower(btrim("email")));

-- Partial index used to derive per-account login throttling from failed-login audit events.
CREATE INDEX "audit_logs_login_failed_email_hash_idx"
  ON "audit_logs" (("metadata" ->> 'emailHash'), "occurred_at")
  WHERE "action" = 'auth.login.failed';

-- audit_logs is append-only: block UPDATE, DELETE and TRUNCATE for every role (second barrier).
CREATE FUNCTION "audit_logs_block_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (% is not allowed)', TG_OP;
END;
$$;

CREATE TRIGGER "audit_logs_no_update_delete"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "audit_logs_block_mutation"();

CREATE TRIGGER "audit_logs_no_truncate"
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_logs_block_mutation"();

-- The application role must not be able to modify audit history (first barrier).
-- The role name matches infra/docker/postgres/init/01-roles.sql; production must use the same
-- separation between owner and application roles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legaltech_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_logs" FROM "legaltech_app";
  END IF;
END;
$$;
