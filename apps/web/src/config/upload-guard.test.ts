import { DOCUMENT_MAX_BYTES } from "@legaltech/contracts";
import { describe, expect, it } from "vitest";
import { oversizedUploadError } from "./upload-guard";

const UPLOAD = "/api/cases/7b1f5c2e-0d4a-4a4e-9a38-3d5c1f0e2b11/documents";

describe("oversizedUploadError", () => {
  it("answers an upload declared over the limit with the API's own 413 body", () => {
    expect(oversizedUploadError("POST", UPLOAD, String(DOCUMENT_MAX_BYTES + 1), "rid")).toEqual({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "La solicitud supera el tamaño máximo permitido.",
        details: [],
        requestId: "rid",
      },
    });
    expect(oversizedUploadError("POST", UPLOAD, String(50 * 1024 * 1024), "rid")).not.toBeNull();
  });

  it("lets through an upload up to the limit, one without a declared length, and anything else", () => {
    expect(oversizedUploadError("POST", UPLOAD, String(DOCUMENT_MAX_BYTES), "rid")).toBeNull();
    expect(oversizedUploadError("POST", UPLOAD, null, "rid")).toBeNull();
    expect(oversizedUploadError("POST", UPLOAD, "not-a-number", "rid")).toBeNull();
    expect(oversizedUploadError("GET", UPLOAD, String(DOCUMENT_MAX_BYTES + 1), "rid")).toBeNull();
    expect(
      oversizedUploadError("POST", "/api/cases", String(DOCUMENT_MAX_BYTES + 1), "rid"),
    ).toBeNull();
    expect(
      oversizedUploadError("POST", `${UPLOAD}/x`, String(DOCUMENT_MAX_BYTES + 1), "rid"),
    ).toBeNull();
  });
});
