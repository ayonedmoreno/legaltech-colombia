-- Least privilege for the application role (SECURITY_SPEC.md section 1: least privilege and deny by
-- default). Until now it received SELECT, INSERT, UPDATE and DELETE on every table through
-- default privileges, `_prisma_migrations` included. It gets instead exactly what the API uses:
-- no DELETE or TRUNCATE anywhere, nothing on `_prisma_migrations`, and `audit_logs` stays
-- append-only (SELECT, INSERT). UPDATE on `email_outbox` also covers the dispatcher's
-- `SELECT ... FOR UPDATE SKIP LOCKED`.
--
-- Default privileges are withdrawn too: every future table gets its grants explicitly in the
-- migration that creates it (DATABASE_SPEC.md, Migraciones section). The role name matches
-- infra/docker/postgres/init/01-roles.sql; production must use the same separation.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legaltech_app') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "legaltech_app";
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM "legaltech_app";

    GRANT SELECT, INSERT, UPDATE ON TABLE
      "users",
      "sessions",
      "email_verification_tokens",
      "password_reset_tokens",
      "email_outbox"
    TO "legaltech_app";
    GRANT SELECT, INSERT ON TABLE "audit_logs" TO "legaltech_app";

    -- Default privileges of the role running the migrations (the owner, which creates the tables).
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM "legaltech_app";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM "legaltech_app";
  END IF;
END;
$$;
