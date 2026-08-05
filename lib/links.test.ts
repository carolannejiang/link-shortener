import { describe, expect, it } from "vitest";
import {
  normalizeUrl,
  resolveAlias,
  isExpired,
  parseTags,
  parseParams,
  MAX_TAGS,
  SLUG_RE,
  RESERVED,
} from "./links";

describe("normalizeUrl", () => {
  it("leaves http and https URLs untouched", () => {
    expect(normalizeUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
    expect(normalizeUrl("HTTPS://EXAMPLE.COM/X")).toBe("HTTPS://EXAMPLE.COM/X");
  });

  it("prefixes bare domains with https://", () => {
    expect(normalizeUrl("example.com/a/b?c=1")).toBe("https://example.com/a/b?c=1");
    expect(normalizeUrl("foo.trycloudflare.com")).toBe("https://foo.trycloudflare.com");
    expect(normalizeUrl("example.com:8080/x")).toBe("https://example.com:8080/x");
  });

  it("leaves other explicit schemes alone for the protocol check to reject", () => {
    expect(normalizeUrl("ftp://example.com")).toBe("ftp://example.com");
    expect(normalizeUrl("chrome-extension://abc/x")).toBe("chrome-extension://abc/x");
  });

  it("never turns javascript: into a parseable URL", () => {
    // The https:// prefix makes "alert(1)" an invalid port, so URL parsing
    // throws and the API rejects it — rather than storing an odd scheme.
    expect(() => new URL(normalizeUrl("javascript:alert(1)"))).toThrow();
  });
});

describe("SLUG_RE", () => {
  it("accepts lowercase letters, numbers, and dashes", () => {
    expect(SLUG_RE.test("career")).toBe(true);
    expect(SLUG_RE.test("a7f2kq")).toBe(true);
    expect(SLUG_RE.test("my-link-2")).toBe(true);
  });

  it("rejects everything else", () => {
    for (const bad of ["", "Career", "a b", "a/b", "a.b", "café", "a_b", "%61"]) {
      expect(SLUG_RE.test(bad)).toBe(false);
    }
  });
});

describe("resolveAlias", () => {
  it("returns the slug itself when it isn't an alias", () => {
    expect(resolveAlias({}, "career")).toBe("career");
  });

  it("follows a single alias hop", () => {
    expect(resolveAlias({ "bootcamp-eoi": "bootcamp-public" }, "bootcamp-eoi")).toBe(
      "bootcamp-public",
    );
  });

  it("follows a short chain to the real link", () => {
    const aliases = { a: "b", b: "c" };
    expect(resolveAlias(aliases, "a")).toBe("c");
  });

  it("bails out of a hand-edited cycle instead of looping forever", () => {
    const aliases = { a: "b", b: "a" };
    // Which slug it lands on doesn't matter — only that it terminates and
    // returns something from the cycle.
    expect(["a", "b"]).toContain(resolveAlias(aliases, "a"));
  });
});

describe("isExpired", () => {
  const now = 1_000_000;

  it("treats 0 as never expiring", () => {
    expect(isExpired(0, now)).toBe(false);
  });

  it("is not expired before the timestamp", () => {
    expect(isExpired(now + 1, now)).toBe(false);
  });

  it("is expired at or after the timestamp", () => {
    expect(isExpired(now, now)).toBe(true);
    expect(isExpired(now - 1, now)).toBe(true);
  });
});

describe("parseTags", () => {
  it("splits, trims, lowercases, and cleans a comma string", () => {
    expect(parseTags(" Job-Search , Social ")).toEqual(["job-search", "social"]);
  });

  it("accepts an array too", () => {
    expect(parseTags(["Work", "work", "  "])).toEqual(["work"]);
  });

  it("drops disallowed characters and empties", () => {
    expect(parseTags("a b, c/d, ,🎉")).toEqual(["ab", "cd"]);
  });

  it("dedupes and caps the count", () => {
    const many = Array.from({ length: MAX_TAGS + 5 }, (_, i) => `t${i}`).join(",");
    expect(parseTags(many)).toHaveLength(MAX_TAGS);
    expect(parseTags("x,x,x")).toEqual(["x"]);
  });

  it("returns [] for empty or nullish input", () => {
    expect(parseTags("")).toEqual([]);
    expect(parseTags(null)).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
  });
});

describe("parseParams", () => {
  it("normalizes a query string and strips a leading ?", () => {
    expect(parseParams("?utm_source=resume&utm_medium=qr")).toBe(
      "utm_source=resume&utm_medium=qr",
    );
  });

  it("drops empty-named keys and blank input", () => {
    expect(parseParams("=x&a=1")).toBe("a=1");
    expect(parseParams("   ")).toBe("");
    expect(parseParams(null)).toBe("");
  });

  it("url-encodes values so the result is a safe query string", () => {
    expect(parseParams("q=a b&t=x/y")).toBe("q=a+b&t=x%2Fy");
  });
});

describe("RESERVED", () => {
  it("covers the app's own routes", () => {
    expect(RESERVED.has("admin")).toBe(true);
    expect(RESERVED.has("api")).toBe(true);
  });
});
