-- First Documents slice (Phase 3; DATABASE_SPEC.md): document metadata. The files live in private
-- object storage behind StorageProvider, never in PostgreSQL (PROJECT_SPEC.md s.16).

-- CreateEnum
CREATE TYPE "document_file_type" AS ENUM ('PDF', 'JPEG', 'PNG');

-- CreateEnum
CREATE TYPE "document_status" AS ENUM ('UPLOADED');

-- CreateEnum
CREATE TYPE "document_ocr_status" AS ENUM ('NOT_STARTED');

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "case_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_type" "document_file_type" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "document_status" NOT NULL DEFAULT 'UPLOADED',
    "ocr_status" "document_ocr_status" NOT NULL DEFAULT 'NOT_STARTED',

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_storage_key_key" ON "documents"("storage_key");

-- CreateIndex
CREATE INDEX "documents_case_id_created_at_idx" ON "documents"("case_id", "created_at");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A stored file always has content.
ALTER TABLE "documents" ADD CONSTRAINT "documents_file_size_positive" CHECK ("file_size" > 0);

-- Application role (least privilege): in this slice a document is created and read, never
-- changed or deleted.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legaltech_app') THEN
    GRANT SELECT, INSERT ON TABLE "documents" TO "legaltech_app";
  END IF;
END;
$$;
