import { describe, expect, it } from "vitest";

import { SubstackAuthError } from "../../src/substack/errors.js";
import type { FetchLike, FetchRedirectMode } from "../../src/substack/types.js";
import {
  summarizeUploadImage,
  uploadImage,
} from "../../src/tools/uploadImage.js";
import { captureAuditEvents } from "../helpers/audit.js";

const config = {
  maxImageBytes: 8,
  publicationUrl: undefined,
  sessionToken: undefined,
  substackRequestTimeoutMs: 30_000,
  userId: undefined,
  userAgent: "test-agent",
};

describe("uploadImage", () => {
  it("uploads a base64 data URI and returns metadata", async () => {
    const { auditLogger, events: auditEvents } = captureAuditEvents();
    let capturedDataUri = "";
    const result = await uploadImage(
      {
        image_base64: "data:image/png;base64,aGVsbG8=",
        alt_text: "Alt",
        caption: "Caption",
      },
      config,
      {
        auditLogger,
        client: {
          uploadImage: async (dataUri) => {
            capturedDataUri = dataUri;
            return { url: "https://substackcdn.com/image.png" };
          },
        },
      },
    );

    expect(capturedDataUri).toBe("data:image/png;base64,aGVsbG8=");
    expect(result).toEqual({
      ok: true,
      errors: [],
      image_url: "https://substackcdn.com/image.png",
      alt_text: "Alt",
      caption: "Caption",
      message: "Uploaded image to Substack: https://substackcdn.com/image.png",
    });
    expect(summarizeUploadImage(result)).toBe(result.message);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      event_type: "mcp_audit",
      action: "upload_image",
      outcome: "success",
      image_source: "data_uri",
      alt_text_present: true,
      caption_present: true,
      warning_count: 0,
      error_count: 0,
    });
    const serializedAudit = JSON.stringify(auditEvents);
    expect(serializedAudit).not.toContain("aGVsbG8=");
    expect(serializedAudit).not.toContain("https://substackcdn.com/image.png");
    expect(serializedAudit).not.toContain("Alt");
    expect(serializedAudit).not.toContain("Caption");
  });

  it("infers MIME type for raw base64 from filename_hint", async () => {
    let capturedDataUri = "";
    const result = await uploadImage(
      {
        image_base64: "aGk",
        filename_hint: "photo.webp",
      },
      config,
      {
        client: {
          uploadImage: async (dataUri) => {
            capturedDataUri = dataUri;
            return { url: "https://substackcdn.com/image.webp" };
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(capturedDataUri).toBe("data:image/webp;base64,aGk=");
  });

  it("rejects unsafe or unsupported filename hints before upload", async () => {
    let uploadCalls = 0;
    const client = {
      uploadImage: async () => {
        uploadCalls += 1;
        return { url: "https://substackcdn.com/image.png" };
      },
    };

    await expect(
      uploadImage(
        {
          image_base64: "aGk=",
          filename_hint: "../photo.png",
        },
        config,
        { client },
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["filename_hint must be a simple filename, not a path."],
    });

    await expect(
      uploadImage(
        {
          image_base64: "aGk=",
          filename_hint: "photo.svg",
        },
        config,
        { client },
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: [
        "filename_hint must end with a supported image extension: avif, gif, jpg, jpeg, png, or webp.",
      ],
    });

    await expect(
      uploadImage(
        {
          image_base64: "aGk=",
          filename_hint: " ",
        },
        config,
        { client },
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["filename_hint must not be blank when provided."],
    });

    await expect(
      uploadImage(
        {
          image_base64: "aGk=",
          filename_hint: "photo?.png",
        },
        config,
        { client },
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: [
        "filename_hint must contain only letters, numbers, spaces, dots, dashes, and underscores.",
      ],
    });

    expect(uploadCalls).toBe(0);
  });

  it("normalizes whitespace in base64 data URIs before upload", async () => {
    let capturedDataUri = "";
    const result = await uploadImage(
      {
        image_base64: "data:image/png;base64,aG\n k=",
      },
      config,
      {
        client: {
          uploadImage: async (dataUri) => {
            capturedDataUri = dataUri;
            return { url: "https://substackcdn.com/image.png" };
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(capturedDataUri).toBe("data:image/png;base64,aGk=");
  });

  it("fetches remote images and converts them to data URIs", async () => {
    const fetchCalls: string[] = [];
    const fetchRedirectModes: Array<FetchRedirectMode | undefined> = [];
    const fetchSignals: Array<AbortSignal | undefined> = [];
    let capturedDataUri = "";
    const fetchFn: FetchLike = async (input, init) => {
      fetchCalls.push(input.toString());
      fetchRedirectModes.push(init?.redirect);
      fetchSignals.push(init?.signal);
      return new Response(new Uint8Array([1, 2]), {
        status: 200,
        headers: { "content-type": "image/jpeg; charset=binary" },
      });
    };

    const result = await uploadImage(
      {
        image_url: "https://example.com/image.jpg",
      },
      config,
      {
        fetchFn,
        client: {
          uploadImage: async (dataUri) => {
            capturedDataUri = dataUri;
            return { url: "https://substackcdn.com/image.jpg" };
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(fetchCalls).toEqual(["https://example.com/image.jpg"]);
    expect(fetchRedirectModes).toEqual(["manual"]);
    expect(fetchSignals[0]).toBeInstanceOf(AbortSignal);
    expect(capturedDataUri).toBe("data:image/jpeg;base64,AQI=");
  });

  it("rejects non-public uploaded image URLs returned by the client", async () => {
    await expect(
      uploadImage(
        {
          image_base64: "data:image/png;base64,aGk=",
        },
        config,
        {
          client: {
            uploadImage: async () => ({ url: "data:image/png;base64,aGk=" }),
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["uploaded image_url must use http:// or https://."],
    });

    await expect(
      uploadImage(
        {
          image_base64: "data:image/png;base64,aGk=",
        },
        config,
        {
          client: {
            uploadImage: async () => ({
              url: "https://user:password@substackcdn.com/image.png",
            }),
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["uploaded image_url must not include username or password."],
    });

    await expect(
      uploadImage(
        {
          image_base64: "data:image/png;base64,aGk=",
        },
        config,
        {
          client: {
            uploadImage: async () => ({
              url: "http://127.0.0.1/image.png",
            }),
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: [
        "uploaded image_url must not point to localhost or private network addresses.",
      ],
    });
  });

  it("times out remote image fetches without calling Substack", async () => {
    let uploadCalled = false;
    let capturedSignal: AbortSignal | undefined;
    const fetchFn: FetchLike = async (_input, init = {}) => {
      capturedSignal = init.signal;
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    };

    const result = await uploadImage(
      {
        image_url: "https://example.com/slow-image.png",
      },
      { ...config, substackRequestTimeoutMs: 1 },
      {
        fetchFn,
        client: {
          uploadImage: async () => {
            uploadCalled = true;
            return { url: "https://substackcdn.com/image.png" };
          },
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      errors: ["Image fetch timed out after 1 ms."],
    });
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(true);
    expect(uploadCalled).toBe(false);
  });

  it("validates source selection, URL protocol, MIME type, and size", async () => {
    await expect(
      uploadImage({}, config, {
        client: {
          uploadImage: async () => ({ url: "unused" }),
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["Exactly one of image_url or image_base64 is required."],
    });

    await expect(
      uploadImage(
        {
          image_url: "https://example.com/image.png",
          image_base64: "data:image/png;base64,aGk=",
        },
        config,
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["Exactly one of image_url or image_base64 is required."],
    });

    await expect(
      uploadImage(
        {
          image_url: "not a url",
        },
        config,
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["image_url must be a valid URL."],
    });

    await expect(
      uploadImage(
        {
          image_url: "file:///tmp/image.png",
        },
        config,
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["image_url must use http:// or https://."],
    });

    let credentialedUrlFetched = false;
    await expect(
      uploadImage(
        {
          image_url: "https://user:password@example.com/image.png",
        },
        config,
        {
          fetchFn: async () => {
            credentialedUrlFetched = true;
            return new Response(new Uint8Array([1]), {
              status: 200,
              headers: { "content-type": "image/png" },
            });
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["image_url must not include username or password."],
    });
    expect(credentialedUrlFetched).toBe(false);

    let privateUrlFetched = false;
    await expect(
      uploadImage(
        {
          image_url: "http://127.0.0.1/image.png",
        },
        config,
        {
          fetchFn: async () => {
            privateUrlFetched = true;
            return new Response(new Uint8Array([1]), {
              status: 200,
              headers: { "content-type": "image/png" },
            });
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: [
        "image_url must not point to localhost or private network addresses.",
      ],
    });
    expect(privateUrlFetched).toBe(false);

    await expect(
      uploadImage(
        {
          image_base64: "data:text/plain;base64,aGk=",
        },
        config,
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["Unsupported image MIME type: text/plain."],
    });

    await expect(
      uploadImage(
        {
          image_base64: "not-valid-base64!",
          filename_hint: "image.png",
        },
        config,
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["image_base64 must be valid base64 data."],
    });

    await expect(
      uploadImage(
        {
          image_base64: "aG",
          filename_hint: "image.png",
        },
        config,
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["image_base64 must be valid base64 data."],
    });

    await expect(
      uploadImage(
        {
          image_base64: "ab==",
          filename_hint: "image.png",
        },
        config,
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["image_base64 must be valid base64 data."],
    });

    await expect(
      uploadImage(
        {
          image_base64: "aGk=",
        },
        config,
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["Unsupported image MIME type: unknown."],
    });

    await expect(
      uploadImage(
        {
          image_base64: "aGVsbG8=",
          filename_hint: "image.png",
        },
        { ...config, maxImageBytes: 1 },
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["Image is 5 byte(s), which exceeds MAX_IMAGE_BYTES=1."],
    });
  });

  it("returns fetch, config, and Substack API errors", async () => {
    const fetchNotFound = await uploadImage(
      {
        image_url: "https://example.com/missing.png",
      },
      config,
      {
        fetchFn: async () => new Response("", { status: 404 }),
      },
    );
    expect(fetchNotFound.errors).toEqual(["Image fetch failed with HTTP 404."]);

    const fetchRedirect = await uploadImage(
      {
        image_url: "https://example.com/redirect.png",
      },
      config,
      {
        fetchFn: async (_input, init) => {
          expect(init?.redirect).toBe("manual");
          return new Response("", {
            status: 302,
            headers: { location: "http://127.0.0.1/private.png" },
          });
        },
      },
    );
    expect(fetchRedirect.errors).toEqual([
      "Image fetch redirected; provide the final public image URL directly.",
    ]);

    const fetchNoMime = await uploadImage(
      {
        image_url: "https://example.com/image",
      },
      config,
      {
        fetchFn: async () => new Response(new Uint8Array([1]), { status: 200 }),
      },
    );
    expect(fetchNoMime.errors).toEqual([
      "Unsupported image MIME type: unknown.",
    ]);

    const fetchTooLarge = await uploadImage(
      {
        image_url: "https://example.com/image.png",
      },
      { ...config, maxImageBytes: 1 },
      {
        fetchFn: async () =>
          new Response(new Uint8Array([1, 2]), {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
      },
    );
    expect(fetchTooLarge.errors).toEqual([
      "Image is 2 byte(s), which exceeds MAX_IMAGE_BYTES=1.",
    ]);

    let streamPullCount = 0;
    let streamCanceled = false;
    const streamTooLarge = await uploadImage(
      {
        image_url: "https://example.com/streamed-image.png",
      },
      { ...config, maxImageBytes: 1 },
      {
        fetchFn: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                streamPullCount += 1;
                controller.enqueue(new Uint8Array([streamPullCount, 0]));
                if (streamPullCount >= 3) {
                  controller.close();
                }
              },
              cancel() {
                streamCanceled = true;
              },
            }),
            {
              status: 200,
              headers: { "content-type": "image/png" },
            },
          ),
      },
    );
    expect(streamTooLarge.errors).toEqual([
      "Image is 2 byte(s), which exceeds MAX_IMAGE_BYTES=1.",
    ]);
    expect(streamPullCount).toBeLessThan(3);
    expect(streamCanceled).toBe(true);

    const fetchDeclaredTooLarge = await uploadImage(
      {
        image_url: "https://example.com/declared-large.png",
      },
      { ...config, maxImageBytes: 1 },
      {
        fetchFn: async () =>
          new Response(new Uint8Array([1]), {
            status: 200,
            headers: {
              "content-type": "image/png",
              "content-length": "9",
            },
          }),
      },
    );
    expect(fetchDeclaredTooLarge.errors).toEqual([
      "Image is 9 byte(s), which exceeds MAX_IMAGE_BYTES=1.",
    ]);

    const fetchThrown = await uploadImage(
      {
        image_url: "https://example.com/image.png",
      },
      config,
      {
        fetchFn: async () => {
          throw new Error("network failed with SUBSTACK_SESSION_TOKEN=secret");
        },
      },
    );
    expect(fetchThrown.errors).toEqual([
      "network failed with SUBSTACK_SESSION_TOKEN=[REDACTED]",
    ]);

    const fetchAbortError = await uploadImage(
      {
        image_url: "https://example.com/aborted.png",
      },
      config,
      {
        fetchFn: async () => {
          throw new DOMException("The operation was aborted.", "AbortError");
        },
      },
    );
    expect(fetchAbortError.errors).toEqual([
      "Image fetch timed out after 30000 ms.",
    ]);

    const configError = await uploadImage(
      {
        image_base64: "data:image/png;base64,aGk=",
      },
      config,
    );
    expect(configError.errors).toEqual([
      "SUBSTACK_PUBLICATION_URL is required.",
    ]);

    const apiError = await uploadImage(
      {
        image_base64: "data:image/png;base64,aGk=",
      },
      config,
      {
        client: {
          uploadImage: async () => {
            throw new SubstackAuthError("Substack authentication failed.", {
              status: 401,
              responseBody: "connect.sid=secret-session",
            });
          },
        },
      },
    );
    expect(apiError.ok).toBe(false);
    expect(apiError.errors[0]).toContain("HTTP 401");
    expect(apiError.errors[0]).toContain("[REDACTED]");
    expect(apiError.errors[0]).not.toContain("secret-session");
    expect(summarizeUploadImage(apiError)).toBe(
      "Image upload failed with 1 error(s).",
    );
  });
});
