import { describe, expect, it } from "vitest";
import { forgetButtonLabel, forgetConfirmMessage } from "@/components/people/ForgetPersonButton";

describe("the question asked before forgetting somebody", () => {
  it("says the person page and the tags go too, in the default mode", () => {
    const m = forgetConfirmMessage("Vi", "remove-all");
    expect(m).toMatch(/^Forget Vi completely\?/);
    expect(m).toContain("person page");
    expect(m).toContain("every tag");
    expect(m).toContain("cannot be undone");
  });

  it("says the page and the name on confirmed photos stay, when the name is kept", () => {
    const m = forgetConfirmMessage("Vi", "keep-name");
    expect(m).toMatch(/^Forget Vi's face data\?/);
    expect(m).toContain("person page and the name on photos already confirmed stay");
  });

  it("is asked by a button named for the same mode", () => {
    expect(forgetButtonLabel("remove-all")).toBe("Forget completely");
    expect(forgetButtonLabel("keep-name")).toBe("Forget face data, keep the name");
  });
});
