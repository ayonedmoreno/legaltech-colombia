import { createPrismaClient } from "@legaltech/database";
import { activateOcr } from "../ocr/ocr-activation.js";

/**
 * OCR activation (decisions OCR-A11 and OCR-A12), run by the owner, never by a migration and never
 * while a worker runs. Procedure: stop the worker → run this script → start the worker with
 * OCR_ENABLED=true (it checks the invariant again and refuses to start if it does not hold).
 *
 *   OCR_ACTIVATION_DATABASE_URL=<owner connection string> pnpm --filter @legaltech/worker ocr:activate
 */
const url = process.env.OCR_ACTIVATION_DATABASE_URL;
if (!url) {
  console.error("OCR_ACTIVATION_DATABASE_URL is required (the owner's connection string)");
  process.exit(1);
}

const prisma = createPrismaClient(url);
try {
  const result = await activateOcr(prisma);
  // Counts only: never a document's name or content.
  console.log(JSON.stringify({ message: "OCR activated", ...result }));
} catch (error) {
  console.error(
    JSON.stringify({
      message: "OCR activation failed; nothing was changed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
