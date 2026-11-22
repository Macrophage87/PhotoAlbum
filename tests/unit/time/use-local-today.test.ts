import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { useLocalToday } from "@/components/time/useLocalToday";

function Field() {
  return createElement("input", { type: "date", readOnly: true, value: useLocalToday(), "aria-label": "To" });
}

describe("useLocalToday", () => {
  it("leaves the day blank in the server's render, which knows nothing of the reader's zone (#127)", () => {
    const html = renderToString(createElement(Field));
    // Not the server's UTC day (tomorrow on an American evening), and nothing hydration would then disagree with.
    expect(html).not.toContain(new Date().toISOString().slice(0, 10));
    expect(html).not.toMatch(/value="\d{4}-\d{2}-\d{2}"/);
  });
});
