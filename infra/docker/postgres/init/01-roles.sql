-- Development bootstrap: creates the application role used at runtime.
-- The owner role (POSTGRES_USER) runs migrations; the application role never owns tables.
-- Production must replicate this separation with its own secrets (see SECURITY_SPEC.md).

CREATE ROLE legaltech_app LOGIN PASSWORD 'legaltech_app_dev';

GRANT CONNECT ON DATABASE legaltech TO legaltech_app;
GRANT USAGE ON SCHEMA public TO legaltech_app;

ALTER DEFAULT PRIVILEGES FOR ROLE legaltech_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO legaltech_app;
ALTER DEFAULT PRIVILEGES FOR ROLE legaltech_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO legaltech_app;
