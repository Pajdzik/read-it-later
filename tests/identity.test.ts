import { describe, expect, it } from "vitest";
import { articlePath, articleSlug, backupBasename, isArticleId } from "../src/articles/identity";

describe("article addresses", () => {
  it("accepts only the short permanent identity, independently of a title", () => {
    expect(isArticleId("k7m2q9x4")).toBe(true);
    for (const value of [null, "", "K7m2q9x4", "short", "longer123", "ab-cdefg", "../thing", "界界界界界界界界"])
      expect(isArticleId(value)).toBe(false);
  });

  it("normalizes Unicode titles and keeps article identity through title changes", () => {
    expect(articleSlug("  Why — we READ?  ")).toBe("why-we-read");
    expect(articleSlug("Ｆｕｌｌ ｗｉｄｔｈ / 日本語")).toBe("full-width-日本語");
    expect(Array.from(articleSlug("界".repeat(100)))).toHaveLength(80);
    expect(articlePath({ id: "k7m2q9x4", title: "日本語 / Why?" })).toBe("/read/k7m2q9x4/%E6%97%A5%E6%9C%AC%E8%AA%9E-why");
    expect(articlePath({ id: "k7m2q9x4", title: "📰" })).toBe("/read/k7m2q9x4");
  });

  it("produces portable single-file backup names from hostile or empty titles", () => {
    expect(backupBasename("../../Why \\ we read?.md")).toBe("why-we-read-md");
    expect(backupBasename("CON")).toBe("con-article");
    expect(backupBasename("***")).toBe("saved-article");
    expect(new TextEncoder().encode(`${backupBasename("𠀀".repeat(80))}-100.md`).byteLength).toBeLessThan(256);
  });
});
