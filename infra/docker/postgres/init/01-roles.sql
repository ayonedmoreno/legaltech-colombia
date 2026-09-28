-- Development bootstrap: creates the runtime roles (application and worker).
-- The owner role (POSTGRES_USER) runs migrations; the application role never owns tables.
-- Its table privileges are granted explicitly by the migrations, table by table (least privilege;
-- no default privileges). Production must replicate this separation with its own secrets (see
-- SECURITY_SPEC.md).

CREATE ROLE legaltech_app LOGIN PASSWORD 'legaltech_app_dev';

GRANT CONNECT ON DATABASE legaltech TO legaltech_app;
GRANT USAGE ON SCHEMA public TO legaltech_app;

-- The API creates no temporary tables.
REVOKE TEMPORARY ON DATABASE legaltech FROM PUBLIC;

-- Worker role (Phase 3): runs background jobs (pg-boss, document antivirus). Its privileges are
-- granted by the migrations: pg-boss job tables and only the scan columns of documents.
CREATE ROLE legaltech_worker LOGIN PASSWORD 'legaltech_worker_dev';
GRANT CONNECT ON DATABASE legaltech TO legaltech_worker;
GRANT USAGE ON SCHEMA public TO legaltech_worker;
