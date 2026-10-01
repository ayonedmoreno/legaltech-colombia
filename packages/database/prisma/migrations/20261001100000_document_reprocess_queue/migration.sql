-- Queue of the explicit reprocessing of a SCAN_FAILED document (decision of 2026-10-01;
-- DATABASE_SPEC.md "Tratamiento de seguridad del documento"). Created by the owner, like
-- document.scan: not partitioned, so create_queue only inserts a row (no DDL) and its jobs live in
-- pgboss.job_common, where the application role can already enqueue and the worker role consume.
-- No privilege changes. A reprocessing job only moves the document back to PENDING_SCAN if it is
-- still SCAN_FAILED, so retrying it is harmless: 2 retries with a growing delay.
SELECT pgboss.create_queue(
  'document.reprocess',
  '{"policy":"standard","retryLimit":2,"retryDelay":30,"retryBackoff":true,"expireInSeconds":300}'::jsonb
);
