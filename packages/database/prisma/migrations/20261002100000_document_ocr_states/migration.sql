-- OCR states of a document (Phase 3; DATABASE_SPEC.md "OCR del documento", decision OCR-A10.2).
-- In their own migration: PostgreSQL cannot use a new enum value in the transaction that adds it.
-- NOT_APPLICABLE is definitive (an INFECTED document); EXCLUDED is reversible only by an explicit
-- task (a PDF the OCR may not process, or a document that was CLEAN before the OCR was activated).
ALTER TYPE "document_ocr_status" ADD VALUE 'PENDING';
ALTER TYPE "document_ocr_status" ADD VALUE 'PROCESSING';
ALTER TYPE "document_ocr_status" ADD VALUE 'COMPLETED';
ALTER TYPE "document_ocr_status" ADD VALUE 'FAILED';
ALTER TYPE "document_ocr_status" ADD VALUE 'NOT_APPLICABLE';
ALTER TYPE "document_ocr_status" ADD VALUE 'EXCLUDED';
