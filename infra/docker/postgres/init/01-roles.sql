-- Development bootstrap: creates the application role used at runtime.
-- The owner role (POSTGRES_USER) runs migrations; the application role never owns tables.
-- Its table privileges are granted explicitly by the migrations, table by table (least privilege;
-- no default privileges). Production must replicate this separation with its own secrets (see
-- SECURITY_SPEC.md).

CREATE ROLE legaltech_app LOGIN PASSWORD 'legaltech_app_dev';

GRANT CONNECT ON DATABASE legaltech TO legaltech_app;
GRANT USAGE ON SCHEMA public TO legaltech_app;

-- The API creates no temporary tables.
REVOKE TEMPORARY ON DATABASE legaltech FROM PUBLIC;
