-- Hardening of the SECURITY DEFINER function behind the OCR page-consistency triggers (decision
-- OCR-A10.5; SECURITY_SPEC.md, "PostgreSQL"). The function runs with its owner's rights inside the
-- session that fired the trigger. With unqualified names and pg_temp missing from its search_path,
-- PostgreSQL searched that session's temporary schema first, so a role able to create temporary
-- tables could shadow ocr_results/ocr_result_pages and have an inconsistent result committed.
-- Now every object is schema-qualified, the trigger relation is compared by OID, and pg_temp is
-- searched last. The checks themselves are unchanged.
CREATE OR REPLACE FUNCTION public."ocr_result_pages_consistent"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  result_id uuid;
  result_outcome public.ocr_result_outcome;
  result_pages integer;
  stored integer;
  highest integer;
BEGIN
  IF TG_RELID = 'public.ocr_results'::regclass THEN
    result_id := NEW.id;
  ELSE
    result_id := NEW.ocr_result_id;
  END IF;
  SELECT r.outcome, r.pages INTO result_outcome, result_pages
    FROM public.ocr_results r WHERE r.id = result_id;
  SELECT count(*), coalesce(max(p.page_number), 0) INTO stored, highest
    FROM public.ocr_result_pages p WHERE p.ocr_result_id = result_id;
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
REVOKE ALL ON FUNCTION public."ocr_result_pages_consistent"() FROM PUBLIC;

-- A completed execution has at least one page (pages 1..n with n >= 1; OCR-A10.5): an empty list
-- in the read API means "no text in this state", never "zero pages" (API_SPEC.md).
ALTER TABLE public."ocr_results"
  ADD CONSTRAINT "ocr_results_completed_has_pages" CHECK ("outcome" <> 'COMPLETED' OR "pages" >= 1);
