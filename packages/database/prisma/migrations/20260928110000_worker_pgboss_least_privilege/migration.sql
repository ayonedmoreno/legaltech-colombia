-- Least privilege for the worker role in pgboss (Phase 3, slice 3.2b; DATABASE_SPEC.md "Permisos
-- de los roles de ejecucion"). The worker runs pg-boss 12.35.0 with migrate, schedule,
-- persistWarnings, persistQueueStats and reindex off, sends no job with dependencies and does not
-- publish events, so these grants of 20260928100100_document_scan are never used:
--   - DELETE on pgboss.job: pg-boss deletes through the queue's own table (job_common); only
--     delete_queue(), an owner operation, deletes from pgboss.job.
--   - INSERT, UPDATE on pgboss.job_dependency: rows are only inserted for jobs sent with
--     dependencies, and never updated. SELECT and DELETE stay (completion and maintenance).
--   - SELECT on pgboss.schedule (cron, off), pgboss.subscription (publish/subscribe, unused),
--     pgboss.bam (only with migrate) and pgboss.warning (persistWarnings is off).
--   - UPDATE of pgboss.version cron_on, bam_on and reindex_on (their timers are off). flow_on and
--     monitor_backoff_on stay (flow resolution and supervision).
-- Supervision and maintenance are exercised as this role in pgboss.supervision.integration.test.ts.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legaltech_worker') THEN
    REVOKE DELETE ON TABLE pgboss.job FROM "legaltech_worker";
    REVOKE INSERT, UPDATE ON TABLE pgboss.job_dependency FROM "legaltech_worker";
    REVOKE SELECT ON TABLE pgboss.schedule, pgboss.subscription, pgboss.bam, pgboss.warning
      FROM "legaltech_worker";
    REVOKE UPDATE ("cron_on", "bam_on", "reindex_on") ON TABLE pgboss.version FROM "legaltech_worker";
  END IF;
END;
$$;
