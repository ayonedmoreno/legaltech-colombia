import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OCR_UNVERIFIED_WARNING } from "../../../lib/case-labels";
import { OcrText } from "./ocr-text";

/** Untrusted OCR text (decision OCR-A13): rendered as text, never as markup. */
describe("OcrText", () => {
  it("escapes any markup in the text instead of rendering it", () => {
    const html = renderToStaticMarkup(
      <OcrText
        pages={[
          { number: 1, text: "<script>alert('x')</script>" },
          { number: 2, text: '<img src=x onerror="alert(1)"><a href="javascript:alert(2)">y</a>' },
        ]}
      />,
    );

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a href");
    expect(html).toContain("&lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("always shows the unverified warning, with the pages in order", () => {
    const html = renderToStaticMarkup(
      <OcrText
        pages={[
          { number: 1, text: "uno" },
          { number: 2, text: "dos" },
        ]}
      />,
    );
    expect(html).toContain(OCR_UNVERIFIED_WARNING);
    expect(html.indexOf("Página 1")).toBeLessThan(html.indexOf("Página 2"));
    expect(html).not.toMatch(/<(input|textarea)|contenteditable/i);
  });

  it("says there is no text when there are no pages", () => {
    const html = renderToStaticMarkup(<OcrText pages={[]} />);
    expect(html).toContain(OCR_UNVERIFIED_WARNING);
    expect(html).toContain("No hay texto disponible.");
  });
});
