-- Security treatment states of a document (Phase 3, second Documents slice; DATABASE_SPEC.md).
-- In their own migration: PostgreSQL cannot use a new enum value in the transaction that adds it,
-- and the next migration makes PENDING_SCAN the default.
ALTER TYPE "document_status" ADD VALUE 'PENDING_SCAN';
ALTER TYPE "document_status" ADD VALUE 'SCANNING';
ALTER TYPE "document_status" ADD VALUE 'CLEAN';
ALTER TYPE "document_status" ADD VALUE 'INFECTED';
ALTER TYPE "document_status" ADD VALUE 'SCAN_FAILED';
