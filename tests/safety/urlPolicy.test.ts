import { describe, expect, it } from "vitest";

import {
  parseHttpUrl,
  parsePublicHttpsUrl,
} from "../../src/safety/urlPolicy.js";

describe("urlPolicy", () => {
  it("accepts HTTP and HTTPS URLs", () => {
    expect(parseHttpUrl("https://example.com/image.png")).toMatchObject({
      ok: true,
      url: new URL("https://example.com/image.png"),
    });

    expect(parseHttpUrl("http://example.com/image.png")).toMatchObject({
      ok: true,
      url: new URL("http://example.com/image.png"),
    });

    expect(parseHttpUrl("https://8.8.8.8/image.png")).toMatchObject({
      ok: true,
      url: new URL("https://8.8.8.8/image.png"),
    });

    expect(parseHttpUrl("https://one.two.three.four/image.png")).toMatchObject({
      ok: true,
      url: new URL("https://one.two.three.four/image.png"),
    });
  });

  it("rejects invalid URLs and non-HTTP protocols", () => {
    expect(parseHttpUrl("not a url", "image_url")).toEqual({
      ok: false,
      errors: ["image_url must be a valid URL."],
    });

    expect(parseHttpUrl("file:///tmp/image.png", "image_url")).toEqual({
      ok: false,
      errors: ["image_url must use http:// or https://."],
    });

    expect(parseHttpUrl("data:image/png;base64,aGk=", "image_url")).toEqual({
      ok: false,
      errors: ["image_url must use http:// or https://."],
    });
  });

  it("rejects URLs with embedded username or password", () => {
    for (const value of [
      "https://user@example.com/image.png",
      "https://user:password@example.com/image.png",
      "https://:password@example.com/image.png",
    ]) {
      expect(parseHttpUrl(value, "image_url")).toEqual({
        ok: false,
        errors: ["image_url must not include username or password."],
      });
    }
  });

  it("rejects localhost and private network hosts", () => {
    for (const value of [
      "http://localhost/image.png",
      "http://assets.localhost/image.png",
      "http://0.0.0.0/image.png",
      "http://127.0.0.1/image.png",
      "http://10.0.0.5/image.png",
      "http://100.64.0.5/image.png",
      "http://172.20.0.5/image.png",
      "http://192.0.0.5/image.png",
      "http://192.168.1.5/image.png",
      "http://169.254.1.5/image.png",
      "http://198.18.0.5/image.png",
      "http://224.0.0.1/image.png",
      "http://[::]/image.png",
      "http://[::1]/image.png",
      "http://[0:0:0:0:0:0:0:1]/image.png",
      "http://[fd00::1]/image.png",
      "http://[fe80::1]/image.png",
      "http://[ff00::1]/image.png",
      "http://[::ffff:127.0.0.1]/image.png",
    ]) {
      expect(parseHttpUrl(value, "image_url")).toEqual({
        ok: false,
        errors: [
          "image_url must not point to localhost or private network addresses.",
        ],
      });
    }
  });

  it("requires public HTTPS URLs for authenticated service origins", () => {
    expect(
      parsePublicHttpsUrl("https://example.substack.com///", "origin"),
    ).toMatchObject({
      ok: true,
      url: new URL("https://example.substack.com///"),
    });

    expect(parsePublicHttpsUrl("http://example.com", "origin")).toEqual({
      ok: false,
      errors: ["origin must use https://."],
    });

    expect(parsePublicHttpsUrl("https://127.0.0.1", "origin")).toEqual({
      ok: false,
      errors: [
        "origin must not point to localhost or private network addresses.",
      ],
    });
  });
});
