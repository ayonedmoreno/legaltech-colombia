-- The text of each OCR execution, per page, in PostgreSQL (decision OCR-A10.5; DATABASE_SPEC.md
-- "OCR del documento"). One row per page of one execution: the history of executions is kept and a
-- finished result never changes (OCR-A10.3). The worker only inserts, without reading anything
-- back; the application role only reads, for the owner and through document -> case -> owner.
-- The text never counts toward the 100 MiB document quota (decision of 2026-10-03).

-- CreateTable
CREATE TABLE "ocr_result_pages" (
    "ocr_result_id" UUID NOT NULL,
    "page_number" INTEGER NOT NULL,
    "text" TEXT NOT NULL,

    -- One row per page of an execution: a page can never be stored twice.
    CONSTRAINT "ocr_result_pages_pkey" PRIMARY KEY ("ocr_result_id", "page_number")
);
ALTER TABLE "ocr_result_pages" ADD CONSTRAINT "ocr_result_pages_page_number_positive" CHECK ("page_number" >= 1);

-- AddForeignKey
ALTER TABLE "ocr_result_pages" ADD CONSTRAINT "ocr_result_pages_ocr_result_id_fkey" FOREIGN KEY ("ocr_result_id") REFERENCES "ocr_results"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At commit, every execution touched must be consistent: a COMPLETED one has exactly pages 1..n
-- (n = ocr_results.pages), a FAILED one has none, and no page can be added to an execution later
-- (a finished result never changes). Checked at commit (deferred) because the worker writes the
-- result and its pages in one transaction. SECURITY DEFINER so that it can count the pages as the
-- owner: the worker itself never reads ocr_results or ocr_result_pages. It returns nothing and
-- nobody may call it directly.
CREATE FUNCTION "ocr_result_pages_consistent"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  result_id uuid;
  result_outcome ocr_result_outcome;
  result_pages integer;
  stored integer;
  highest integer;
BEGIN
  IF TG_TABLE_NAME = 'ocr_results' THEN
    result_id := NEW.id;
  ELSE
    result_id := NEW.ocr_result_id;
  END IF;
  SELECT outcome, pages INTO result_outcome, result_pages FROM ocr_results WHERE id = result_id;
  SELECT count(*), coalesce(max(page_number), 0) INTO stored, highest
    FROM ocr_result_pages WHERE ocr_result_id = result_id;
  IF result_outcome = 'COMPLETED' AND (stored <> result_pages OR highest <> result_pages) THEN
    RAISE EXCEPTION 'OCR result % must have exactly pages 1..%', result_id, result_pages
      USING ERRCODE = 'check_violation';
  END IF;
  IF result_outcome = 'FAILED' AND stored > 0 THEN
    RAISE EXCEPTION 'failed OCR result % cannot have pages', result_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION "ocr_result_pages_consistent"() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER "ocr_results_pages_consistent"
  AFTER INSERT ON "ocr_results" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "ocr_result_pages_consistent"();
CREATE CONSTRAINT TRIGGER "ocr_result_pages_consistent"
  AFTER INSERT ON "ocr_result_pages" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "ocr_result_pages_consistent"();

-- Least privilege (decisions OCR-A10.5 and OCR-A12): the worker INSERTs the pages and reads
-- nothing (no RETURNING); the application role reads results and pages to serve the owner, and
-- writes nothing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legaltech_worker') THEN
    GRANT INSERT ON TABLE "ocr_result_pages" TO "legaltech_worker";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legaltech_app') THEN
    GRANT SELECT ON TABLE "ocr_results", "ocr_result_pages" TO "legaltech_app";
  END IF;
END;
$$;
