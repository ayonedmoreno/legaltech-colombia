-- First Case slice (Phase 2; DATABASE_SPEC.md): case types and statuses from PROJECT_SPEC.md s.9
-- and s.8, the cases and their status history, and audit_logs.case_id.

-- CreateEnum
CREATE TYPE "case_type" AS ENUM ('TRAFFIC_CITATION', 'INFRACTION', 'PHOTO_ENFORCEMENT', 'TRANSPORT', 'NOTIFICATION', 'ADMINISTRATIVE_PROCEEDING', 'OTHER');

-- CreateEnum
CREATE TYPE "case_status" AS ENUM ('DRAFT', 'DOCUMENTS_PENDING', 'PRELIMINARY_ANALYSIS', 'PAYMENT_PENDING', 'PAID', 'LEGAL_REVIEW', 'DOCUMENT_PREPARATION', 'READY_TO_FILE', 'FILED', 'WAITING_RESPONSE', 'RESPONSE_RECEIVED', 'FOLLOW_UP', 'RESOLVED', 'CLOSED', 'CANCELLED');

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "case_id" UUID;

-- CreateTable
CREATE TABLE "cases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" "case_type" NOT NULL,
    "status" "case_status" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_status_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "case_id" UUID NOT NULL,
    "from_status" "case_status",
    "to_status" "case_status" NOT NULL,
    "changed_by_user_id" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cases_user_id_created_at_idx" ON "cases"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "case_status_history_case_id_changed_at_idx" ON "case_status_history"("case_id", "changed_at");

-- CreateIndex
CREATE INDEX "audit_logs_case_id_occurred_at_idx" ON "audit_logs"("case_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_status_history" ADD CONSTRAINT "case_status_history_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_status_history" ADD CONSTRAINT "case_status_history_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Application role (least privilege, DATABASE_SPEC.md "Permisos del rol de aplicacion"): this
-- slice only creates and reads cases, and the status history is append-only. UPDATE on "cases"
-- is granted with the first status transition.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legaltech_app') THEN
    GRANT SELECT, INSERT ON TABLE "cases", "case_status_history" TO "legaltech_app";
  END IF;
END;
$$;
