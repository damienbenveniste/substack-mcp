import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  assertImageVisualFidelity,
  compareImageTransformationMetadata,
  prepareImage,
} from "../../src/images/prepareImage.js";
import { SubstackAuthError } from "../../src/substack/errors.js";
import type { FetchLike, FetchRedirectMode } from "../../src/substack/types.js";
import {
  summarizeUploadImage,
  UploadImageInputSchema,
  uploadImage,
} from "../../src/tools/uploadImage.js";
import { captureAuditEvents } from "../helpers/audit.js";

const config = {
  maxImageBytes: 8_000_000,
  imageFileRoots: [],
  publicationUrl: undefined,
  sessionToken: undefined,
  substackRequestTimeoutMs: 30_000,
  userId: undefined,
  userAgent: "test-agent",
};

const validPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWP4oBGwHxkzEBQAAJVxGdV+F71hAAAAAElFTkSuQmCC";
const validWebpBase64 =
  "UklGRjwAAABXRUJQVlA4IDAAAAAQAgCdASoEAAMAAUAmJaACdLoB+AH4AAPIAP7tzt/+yr4TI/9Uz/6nCXIMfQoAAAA=";
const malformedPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8BQDwAFgwJ/lJ2n4QAAAABJRU5ErkJggg==";
const animatedGifBase64 =
  "R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAIfkEAAAAAAAsAAAAAAEAAQAAAgJEAQA7";

describe("uploadImage", () => {
  it("detects RGB-to-monochrome and major size changes in metadata comparisons", () => {
    const warnings = compareImageTransformationMetadata(
      {
        filename: "source.png",
        format: "png",
        mimeType: "image/png",
        width: 1000,
        height: 500,
        colorMode: "RGB",
        sizeBytes: 1_000_000,
        sha256: "a".repeat(64),
      },
      {
        filename: "processed.png",
        format: "png",
        mimeType: "image/png",
        width: 400,
        height: 200,
        colorMode: "GRAYSCALE",
        sizeBytes: 10_000,
        sha256: "b".repeat(64),
      },
    );

    expect(warnings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "DIMENSIONS_CHANGED",
        "IMAGE_RESIZED",
        "MAJOR_SIZE_REDUCTION",
        "COLOR_MODE_CHANGED",
      ]),
    );
  });

  it("requires explicit permission for material visual-fidelity changes", () => {
    const source = {
      filename: "source.png",
      format: "png",
      mimeType: "image/png",
      width: 100,
      height: 100,
      colorMode: "RGB",
      sizeBytes: 1000,
      sha256: "a".repeat(64),
    };

    expect(() =>
      assertImageVisualFidelity({}, source, {
        ...source,
        height: 50,
        sha256: "b".repeat(64),
      }),
    ).toThrow("unexpectedly changed the aspect ratio");
    expect(() =>
      assertImageVisualFidelity({ require_visual_fidelity: false }, source, {
        ...source,
        colorMode: "GRAYSCALE",
        sha256: "b".repeat(64),
      }),
    ).toThrow("unexpectedly changed the color mode");
    expect(() =>
      assertImageVisualFidelity(
        {
          require_visual_fidelity: false,
          allow_color_mode_change: true,
        },
        source,
        {
          ...source,
          height: 50,
          colorMode: "GRAYSCALE",
          sha256: "b".repeat(64),
        },
      ),
    ).not.toThrow();
    expect(() =>
      assertImageVisualFidelity({ require_visual_fidelity: false }, source, {
        ...source,
        height: 50,
        sha256: "b".repeat(64),
      }),
    ).not.toThrow();
  });

  it("uploads a base64 data URI and returns metadata", async () => {
    const { auditLogger, events: auditEvents } = captureAuditEvents();
    let capturedDataUri = "";
    const result = await uploadImage(
      {
        image_base64: `data:image/png;base64,${validPngBase64}`,
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

    const capturedMetadata = await imageMetadataFromDataUri(capturedDataUri);
    const capturedBytes = dataUriBytes(capturedDataUri);
    expect(capturedMetadata).toMatchObject({
      format: "png",
      width: 4,
      height: 3,
    });
    expect(result).toMatchObject({
      ok: true,
      errors: [],
      image_url: "https://substackcdn.com/image.png",
      filename: expect.stringMatching(/^substack-image-[0-9a-f]{12}\.png$/u),
      format: "png",
      width: 4,
      height: 3,
      size_bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      source_type: "base64",
      alt_text: "Alt",
      caption: "Caption",
      warnings: expect.any(Array),
      warning_details: expect.any(Array),
      source: {
        filename: expect.any(String),
        format: "png",
        mime_type: "image/png",
        width: 4,
        height: 3,
        size_bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      processed: {
        filename: expect.stringMatching(/\.png$/u),
        format: "png",
        mime_type: "image/png",
        width: 4,
        height: 3,
        size_bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      preview_url: "https://substackcdn.com/image.png",
      message: "Uploaded image to Substack: https://substackcdn.com/image.png",
    });
    expect(result.size_bytes).toBe(capturedBytes.byteLength);
    expect(result.sha256).toBe(
      createHash("sha256").update(capturedBytes).digest("hex"),
    );
    expect(summarizeUploadImage(result)).toBe(result.message);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      event_type: "mcp_audit",
      action: "upload_image",
      outcome: "success",
      image_source: "data_uri",
      alt_text_present: true,
      caption_present: true,
      warning_count: result.warnings.length,
      error_count: 0,
    });
    const serializedAudit = JSON.stringify(auditEvents);
    expect(serializedAudit).not.toContain(validPngBase64);
    expect(serializedAudit).not.toContain("https://substackcdn.com/image.png");
    expect(serializedAudit).not.toContain("Alt");
    expect(serializedAudit).not.toContain("Caption");
  });

  it("uploads the exact allowlisted local artifact and never selects a neighboring file", async () => {
    const root = await mkdtemp(join(tmpdir(), "substack-mcp-images-"));
    try {
      const intended = await sharp({
        create: {
          width: 20,
          height: 10,
          channels: 3,
          background: { r: 220, g: 20, b: 30 },
        },
      })
        .png()
        .toBuffer();
      const neighboring = await sharp({
        create: {
          width: 20,
          height: 10,
          channels: 3,
          background: { r: 20, g: 30, b: 220 },
        },
      })
        .png()
        .toBuffer();
      const intendedPath = join(root, "intended.png");
      await writeFile(intendedPath, intended);
      await writeFile(join(root, "neighbor.png"), neighboring);

      let uploadedDataUri = "";
      const result = await uploadImage(
        { source_type: "file", image_file: intendedPath },
        { ...config, imageFileRoots: [root] },
        { client: captureUpload((value) => (uploadedDataUri = value)) },
      );

      const intendedSha256 = createHash("sha256")
        .update(intended)
        .digest("hex");
      const neighboringSha256 = createHash("sha256")
        .update(neighboring)
        .digest("hex");
      expect(result).toMatchObject({
        ok: true,
        source_type: "file",
        source_artifact_id: `sha256:${intendedSha256}`,
        source: {
          filename: "intended.png",
          width: 20,
          height: 10,
          sha256: intendedSha256,
          artifact_id: `sha256:${intendedSha256}`,
        },
        processed: { width: 20, height: 10 },
      });
      expect(result.source?.sha256).not.toBe(neighboringSha256);
      expect(dataUriBytes(uploadedDataUri)).not.toEqual(neighboring);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails clearly when an exact file artifact is unavailable and never uploads a substitute", async () => {
    const root = await mkdtemp(join(tmpdir(), "substack-mcp-images-"));
    try {
      let uploadCount = 0;
      const client = {
        uploadImage: async () => {
          uploadCount += 1;
          return { url: "https://substackcdn.com/unexpected.png" };
        },
      };

      for (const imageFile of [
        join(root, "missing.png"),
        { file_id: "opaque-chat-upload" },
        [join(root, "one.png"), join(root, "two.png")],
      ]) {
        const result = await uploadImage(
          { source_type: "file", image_file: imageFile },
          { ...config, imageFileRoots: [root] },
          { client },
        );
        expect(result).toMatchObject({
          ok: false,
          error: { code: "SOURCE_ARTIFACT_UNAVAILABLE", stage: "source" },
        });
        expect(result.errors[0]).toContain("No substitute was uploaded");
      }
      expect(uploadCount).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces local artifact boundaries and preserves mounted-file identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "substack-mcp-allowed-"));
    const outside = await mkdtemp(join(tmpdir(), "substack-mcp-outside-"));
    try {
      const png = await sharp({
        create: {
          width: 12,
          height: 8,
          channels: 3,
          background: { r: 90, g: 120, b: 150 },
        },
      })
        .png()
        .toBuffer();
      const pngSha256 = createHash("sha256").update(png).digest("hex");
      const pngPath = join(root, "mounted.png");
      const outsidePath = join(outside, "outside.png");
      const svgPath = join(root, "mounted.svg");
      const extensionlessPath = join(root, "mounted-artifact");
      await writeFile(pngPath, png);
      await writeFile(outsidePath, png);
      await writeFile(extensionlessPath, png);
      await writeFile(
        svgPath,
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#159957"/></svg>',
      );
      const prepareConfig = {
        maxImageBytes: config.maxImageBytes,
        substackRequestTimeoutMs: config.substackRequestTimeoutMs,
        imageFileRoots: [join(root, "missing-root"), root],
      };

      const mounted = await prepareImage(
        {
          source_type: "file",
          image_file: {
            artifact_id: "mounted-artifact",
            path: pngPath,
            name: "renamed.png",
            expected_sha256: pngSha256.toUpperCase(),
          },
        },
        prepareConfig,
      );
      expect(mounted).toMatchObject({
        ok: true,
        image: {
          sourceType: "file",
          source: {
            filename: "renamed.png",
            artifactId: "mounted-artifact",
            sha256: pngSha256,
          },
        },
      });

      expect(
        await prepareImage(
          { source_type: "file", image_file: [pngPath] },
          prepareConfig,
        ),
      ).toMatchObject({ ok: true });

      expect(
        await prepareImage(
          { source_type: "file", image_file: extensionlessPath },
          prepareConfig,
        ),
      ).toMatchObject({
        ok: true,
        image: {
          source: { format: "png", mimeType: "image/png" },
        },
      });

      const localSvg = await prepareImage(
        { source_type: "file", image_file: svgPath },
        prepareConfig,
      );
      expect(localSvg).toMatchObject({
        ok: true,
        image: {
          source: { format: "svg", width: 40, height: 20 },
          processed: { format: "png", width: 40, height: 20 },
        },
      });
      expect(
        localSvg.ok ? localSvg.image.warnings.map(({ code }) => code) : [],
      ).toEqual(
        expect.arrayContaining(["FORMAT_CONVERTED", "SVG_CONVERTED_TO_PNG"]),
      );

      const cases = [
        await prepareImage(
          { source_type: "file", image_file: "relative.png" },
          {
            maxImageBytes: config.maxImageBytes,
            substackRequestTimeoutMs: config.substackRequestTimeoutMs,
          },
        ),
        await prepareImage(
          { source_type: "file", image_file: outsidePath },
          prepareConfig,
        ),
        await prepareImage(
          { source_type: "file", image_file: root },
          prepareConfig,
        ),
        await prepareImage(
          {
            source_type: "file",
            image_file: { path: pngPath, expected_sha256: "not-a-checksum" },
          },
          prepareConfig,
        ),
        await prepareImage(
          { source_type: "file", image_file: pngPath },
          { ...prepareConfig, maxImageBytes: 1 },
        ),
      ];
      expect(cases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ok: false,
            error: expect.objectContaining({
              code: "SOURCE_ARTIFACT_UNAVAILABLE",
            }),
          }),
          expect.objectContaining({
            ok: false,
            error: expect.objectContaining({ code: "FILE_READ_FAILED" }),
          }),
          expect.objectContaining({
            ok: false,
            error: expect.objectContaining({ code: "IMAGE_TOO_LARGE" }),
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("fails closed for invalid or unavailable downloadable file references", async () => {
    let uploadCount = 0;
    const client = {
      uploadImage: async () => {
        uploadCount += 1;
        return { url: "https://substackcdn.com/unexpected.png" };
      },
    };

    for (const size of [-1, 1.5, config.maxImageBytes + 1]) {
      const result = await uploadImage(
        {
          source_type: "file",
          image_file: {
            download_url: "https://files.example.com/generated.png",
            size,
          },
        },
        config,
        { client },
      );
      expect(result.ok).toBe(false);
    }

    const fileFetchCases = [
      async () => new Response("", { status: 404 }),
      async () => {
        throw new DOMException("aborted", "AbortError");
      },
      async () => {
        throw new Error("connector offline");
      },
      async () => {
        throw new Error("");
      },
      async () => Promise.reject("connector rejected"),
    ];
    for (const fetchFn of fileFetchCases) {
      const result = await uploadImage(
        {
          source_type: "file",
          image_file: {
            file_id: "file_unavailable",
            download_url: "https://files.example.com/generated.png",
          },
        },
        config,
        { fetchFn, client },
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: "SOURCE_ARTIFACT_UNAVAILABLE", stage: "download" },
      });
      expect(result.errors[0]).toContain("No substitute was uploaded");
    }

    expect(uploadCount).toBe(0);
  });

  it("uses the runtime fetch fallback without weakening exact-file naming", async () => {
    const source = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .png()
      .toBuffer();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(source, {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
      ),
    );
    try {
      const result = await prepareImage(
        { image_url: "https://93.184.216.34/runtime-fetch.png" },
        {
          maxImageBytes: config.maxImageBytes,
          substackRequestTimeoutMs: config.substackRequestTimeoutMs,
        },
      );
      expect(result).toMatchObject({
        ok: true,
        image: { source: { filename: "runtime-fetch.png" } },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    const fileResult = await prepareImage(
      {
        source_type: "file",
        image_file: {
          download_url: "https://files.example.com/downloaded-asset",
          name: ".",
        },
      },
      {
        maxImageBytes: config.maxImageBytes,
        substackRequestTimeoutMs: config.substackRequestTimeoutMs,
      },
      {
        fetchFn: async () =>
          new Response(source, {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
      },
    );
    expect(fileResult).toMatchObject({
      ok: true,
      image: { source: { filename: "downloaded-asset" } },
    });

    const brokenReference = {
      get file_id(): string {
        throw new Error("broken connector object");
      },
    };
    expect(
      await prepareImage(
        { source_type: "file", image_file: brokenReference },
        {
          maxImageBytes: config.maxImageBytes,
          substackRequestTimeoutMs: config.substackRequestTimeoutMs,
        },
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "IMAGE_CONVERSION_FAILED", stage: "normalization" },
    });
  });

  it("covers visual comparison warnings for aspect ratio and transparency", () => {
    const source = {
      filename: "source.png",
      format: "png",
      mimeType: "image/png",
      width: 1000,
      height: 500,
      colorMode: "RGBA",
      sizeBytes: 0,
      sha256: "a".repeat(64),
    };
    const changed = compareImageTransformationMetadata(source, {
      ...source,
      filename: "processed.png",
      width: 400,
      height: 300,
      colorMode: "RGB",
      sha256: "b".repeat(64),
    });
    expect(changed.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "DIMENSIONS_CHANGED",
        "IMAGE_RESIZED",
        "ASPECT_RATIO_CHANGED",
        "COLOR_MODE_CHANGED",
        "TRANSPARENCY_REMOVED",
      ]),
    );
    expect(compareImageTransformationMetadata(source, source)).toEqual([]);
  });

  it("resolves an exact downloadable file reference and verifies its checksum", async () => {
    const source = await sharp({
      create: {
        width: 80,
        height: 40,
        channels: 3,
        background: { r: 12, g: 90, b: 140 },
      },
    })
      .png()
      .toBuffer();
    const expectedSha256 = createHash("sha256").update(source).digest("hex");
    let uploaded = false;
    const result = await uploadImage(
      {
        source_type: "file",
        image_file: {
          file_id: "file_123",
          download_url: "https://files.example.com/generated.png",
          name: "generated.png",
          mime_type: "image/png",
          size: source.byteLength,
          expected_sha256: expectedSha256,
        },
      },
      config,
      {
        fetchFn: async (url) => {
          expect(url.toString()).toBe(
            "https://files.example.com/generated.png",
          );
          return new Response(source, {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        },
        client: captureUpload(() => (uploaded = true)),
      },
    );

    expect(uploaded).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      source_artifact_id: "file_123",
      source: {
        filename: "generated.png",
        sha256: expectedSha256,
        artifact_id: "file_123",
      },
    });

    let mismatchUploadCount = 0;
    const mismatch = await uploadImage(
      {
        source_type: "file",
        image_file: {
          download_url: "https://files.example.com/generated.png",
          expected_sha256: "0".repeat(64),
        },
      },
      config,
      {
        fetchFn: async () =>
          new Response(source, {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
        client: {
          uploadImage: async () => {
            mismatchUploadCount += 1;
            return { url: "https://substackcdn.com/unexpected.png" };
          },
        },
      },
    );
    expect(mismatch).toMatchObject({
      ok: false,
      error: { code: "SOURCE_ARTIFACT_UNAVAILABLE" },
    });
    expect(mismatchUploadCount).toBe(0);
  });

  it("preserves source filenames for connector download URLs with generic basenames", async () => {
    const source = await sharp({
      create: {
        width: 24,
        height: 12,
        channels: 3,
        background: { r: 12, g: 90, b: 140 },
      },
    })
      .png()
      .toBuffer();
    const fetchFn = async () =>
      new Response(source, {
        status: 200,
        headers: { "content-type": "image/png" },
      });

    const hinted = await prepareImage(
      {
        source_type: "file",
        image_file: {
          file_id: "file_from_connector",
          download_url: "https://files.example.com/raw",
        },
        filename_hint: "original-upload.png",
      },
      config,
      { fetchFn },
    );
    expect(hinted).toMatchObject({
      ok: true,
      image: {
        sourceType: "file",
        source: { filename: "original-upload.png" },
        processed: { filename: "original-upload.png" },
      },
    });

    const named = await prepareImage(
      {
        source_type: "file",
        image_file: {
          file_id: "file_from_connector",
          download_url: "https://files.example.com/raw",
          name: "connector-original.png",
        },
        filename_hint: "normalized-output.png",
      },
      config,
      { fetchFn },
    );
    expect(named).toMatchObject({
      ok: true,
      image: {
        sourceType: "file",
        source: { filename: "connector-original.png" },
        processed: { filename: "normalized-output.png" },
      },
    });
  });

  it("does not treat filename_hint as an image source", async () => {
    await expect(
      prepareImage({ filename_hint: "unbound-image.png" }, config),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "EXACTLY_ONE_IMAGE_SOURCE_REQUIRED",
        stage: "source",
      },
    });
  });

  it("reports transformations and can reject a required resize", async () => {
    const source = await sharp({
      create: {
        width: 200,
        height: 100,
        channels: 3,
        background: { r: 40, g: 120, b: 180 },
      },
    })
      .jpeg({ quality: 95 })
      .toBuffer();
    const image_base64 = `data:image/jpeg;base64,${source.toString("base64")}`;
    const transformed = await uploadImage(
      { image_base64, max_width: 50, max_height: 50 },
      config,
      { client: captureUpload(() => undefined) },
    );
    expect(transformed).toMatchObject({
      ok: true,
      source: { format: "jpeg", width: 200, height: 100 },
      processed: { format: "png", width: 50, height: 25 },
    });
    expect(transformed.warning_details.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "FORMAT_CONVERTED",
        "DIMENSIONS_CHANGED",
        "IMAGE_RESIZED",
      ]),
    );

    let uploadCount = 0;
    const rejected = await uploadImage(
      {
        image_base64,
        max_width: 50,
        max_height: 50,
        allow_resize: false,
      },
      config,
      {
        client: {
          uploadImage: async () => {
            uploadCount += 1;
            return { url: "https://substackcdn.com/unexpected.png" };
          },
        },
      },
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "VISUAL_FIDELITY_CHECK_FAILED", stage: "validation" },
    });
    expect(uploadCount).toBe(0);
  });

  it("reports source color modes and preserves dimensions unless resizing is requested", async () => {
    const prepareConfig = {
      maxImageBytes: config.maxImageBytes,
      substackRequestTimeoutMs: config.substackRequestTimeoutMs,
    };
    const grayscale = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 90, g: 90, b: 90 },
      },
    })
      .toColourspace("b-w")
      .png()
      .toBuffer();
    const grayscaleAlpha = await sharp(Buffer.alloc(20 * 20 * 2, 180), {
      raw: { width: 20, height: 20, channels: 2 },
    })
      .toColourspace("b-w")
      .png()
      .toBuffer();
    const cmyk = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 20, g: 100, b: 180 },
      },
    })
      .toColourspace("cmyk")
      .jpeg()
      .toBuffer();

    const colorResults = await Promise.all([
      prepareImage(
        {
          image_base64: `data:image/png;base64,${grayscale.toString("base64")}`,
        },
        prepareConfig,
      ),
      prepareImage(
        {
          image_base64: `data:image/png;base64,${grayscaleAlpha.toString("base64")}`,
        },
        prepareConfig,
      ),
      prepareImage(
        {
          image_base64: `data:image/jpeg;base64,${cmyk.toString("base64")}`,
        },
        prepareConfig,
      ),
    ]);
    expect(colorResults).toEqual([
      expect.objectContaining({
        ok: true,
        image: expect.objectContaining({
          source: expect.objectContaining({ colorMode: "GRAYSCALE" }),
        }),
      }),
      expect.objectContaining({
        ok: true,
        image: expect.objectContaining({
          source: expect.objectContaining({ colorMode: "GRAYSCALE_ALPHA" }),
        }),
      }),
      expect.objectContaining({
        ok: true,
        image: expect.objectContaining({
          source: expect.objectContaining({ colorMode: "CMYK" }),
        }),
      }),
    ]);

    const large = await sharp({
      create: {
        width: 2000,
        height: 1000,
        channels: 3,
        background: { r: 30, g: 60, b: 90 },
      },
    })
      .jpeg()
      .toBuffer();
    const resized = await prepareImage(
      {
        image_base64: `data:image/jpeg;base64,${large.toString("base64")}`,
        preserve_dimensions: false,
      },
      prepareConfig,
    );
    expect(resized).toMatchObject({
      ok: true,
      image: {
        source: { width: 2000, height: 1000 },
        processed: { width: 1456, height: 728 },
      },
    });

    const tall = await sharp({
      create: {
        width: 100,
        height: 200,
        channels: 3,
        background: { r: 30, g: 60, b: 90 },
      },
    })
      .png()
      .toBuffer();
    expect(
      await prepareImage(
        {
          image_base64: `data:image/png;base64,${tall.toString("base64")}`,
          max_width: 100,
          max_height: 50,
          allow_resize: false,
        },
        prepareConfig,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "VISUAL_FIDELITY_CHECK_FAILED" },
    });
  });

  it("infers MIME type for raw base64 from filename_hint", async () => {
    let capturedDataUri = "";
    const result = await uploadImage(
      {
        image_base64: validWebpBase64,
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
    expect(await imageMetadataFromDataUri(capturedDataUri)).toMatchObject({
      format: "png",
      width: 4,
      height: 3,
    });
    expect(result.filename).toBe("photo.png");

    const extensionOnly = await uploadImage(
      {
        image_base64: validPngBase64,
        filename_hint: ".png",
      },
      config,
      { client: captureUpload(() => undefined) },
    );
    expect(extensionOnly).toMatchObject({
      ok: true,
      filename: "substack-image.png",
    });
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

    await expect(
      uploadImage(
        {
          image_base64: "aGk=",
          filename_hint: `${"a".repeat(252)}.png`,
        },
        config,
        { client },
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["filename_hint must be 255 characters or fewer."],
    });

    expect(uploadCalls).toBe(0);
  });

  it("normalizes whitespace in base64 data URIs before upload", async () => {
    let capturedDataUri = "";
    const result = await uploadImage(
      {
        image_base64: `data:image/png;base64,${validPngBase64.slice(0, 40)}\n ${validPngBase64.slice(40)}`,
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
    expect(await imageMetadataFromDataUri(capturedDataUri)).toMatchObject({
      format: "png",
      width: 4,
      height: 3,
    });
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
      return new Response(Buffer.from(validPngBase64, "base64"), {
        status: 200,
        headers: { "content-type": "image/png; charset=binary" },
      });
    };

    const result = await uploadImage(
      {
        image_url: "https://example.com/image.png",
      },
      config,
      {
        fetchFn,
        client: {
          uploadImage: async (dataUri) => {
            capturedDataUri = dataUri;
            return { url: "https://substackcdn.com/image.png" };
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(fetchCalls).toEqual(["https://example.com/image.png"]);
    expect(fetchRedirectModes).toEqual(["manual"]);
    expect(fetchSignals[0]).toBeInstanceOf(AbortSignal);
    expect(await imageMetadataFromDataUri(capturedDataUri)).toMatchObject({
      format: "png",
      width: 4,
      height: 3,
    });
    expect(result).toMatchObject({
      format: "png",
      source_type: "url",
      width: 4,
      height: 3,
    });
  });

  it("rejects non-public uploaded image URLs returned by the client", async () => {
    await expect(
      uploadImage(
        {
          image_base64: `data:image/png;base64,${validPngBase64}`,
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
          image_base64: `data:image/png;base64,${validPngBase64}`,
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
          image_base64: `data:image/png;base64,${validPngBase64}`,
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

  it("rejects a truncated PNG before upload with a stage-specific error", async () => {
    let uploadCalled = false;
    const result = await uploadImage(
      {
        image_base64: `data:image/png;base64,${malformedPngBase64}`,
      },
      config,
      {
        client: {
          uploadImage: async () => {
            uploadCalled = true;
            return { url: "https://substackcdn.com/corrupt.png" };
          },
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "IMAGE_DECODE_FAILED",
        stage: "decode",
      },
    });
    expect(uploadCalled).toBe(false);
  });

  it("renders safe SVG text and blocks executable or remote SVG content", async () => {
    let capturedDataUri = "";
    const safe = await uploadImage(
      {
        source_type: "svg",
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="100%" height="100%" fill="white"/><text x="120" y="70" text-anchor="middle" font-size="28" fill="black">Draft image</text></svg>',
        filename_hint: "draft-card.svg",
      },
      config,
      {
        client: {
          uploadImage: async (dataUri) => {
            capturedDataUri = dataUri;
            return { url: "https://substackcdn.com/draft-card.png" };
          },
        },
      },
    );

    expect(safe).toMatchObject({
      ok: true,
      filename: "draft-card.png",
      format: "png",
      width: 240,
      height: 120,
      source_type: "svg",
    });
    const safeImage = sharp(dataUriBytes(capturedDataUri));
    const safeStats = await safeImage.stats();
    expect(safeStats.channels.some((channel) => channel.stdev > 1)).toBe(true);

    for (const unsafeSvg of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/tracker.png"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://example.com/external.svg)"/></svg>',
    ]) {
      const unsafe = await uploadImage(
        { source_type: "svg", svg: unsafeSvg },
        config,
        {
          client: {
            uploadImage: async () => {
              throw new Error("Unsafe SVG must not be uploaded.");
            },
          },
        },
      );
      expect(unsafe).toMatchObject({
        ok: false,
        error: {
          code: "SVG_SANITIZATION_FAILED",
          stage: "sanitization",
        },
      });
    }
  });

  it("renders structured cards as normalized PNGs", async () => {
    let capturedDataUri = "";
    const result = await uploadImage(
      {
        source_type: "card",
        card: {
          width: 1200,
          height: 630,
          title: "Substack Drafts",
          subtitle: "Image Upload Test",
          footer: "Created through MCP",
          background: "#ffffff",
          foreground: "#111111",
        },
        filename_hint: "substack-image-test.png",
      },
      config,
      {
        client: {
          uploadImage: async (dataUri) => {
            capturedDataUri = dataUri;
            return { url: "https://substackcdn.com/substack-image-test.png" };
          },
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      filename: "substack-image-test.png",
      format: "png",
      width: 1200,
      height: 630,
      source_type: "card",
    });
    expect(await imageMetadataFromDataUri(capturedDataUri)).toMatchObject({
      format: "png",
      width: 1200,
      height: 630,
    });
  });

  it("resizes oversized raster input, applies EXIF orientation, and preserves alpha", async () => {
    const oversized = await sharp({
      create: {
        width: 2000,
        height: 1000,
        channels: 3,
        background: { r: 20, g: 120, b: 220 },
      },
    })
      .png()
      .toBuffer();
    let resizedDataUri = "";
    const resized = await uploadImage(
      {
        image_base64: `data:image/png;base64,${oversized.toString("base64")}`,
        max_width: 500,
        max_height: 500,
      },
      config,
      { client: captureUpload((value) => (resizedDataUri = value)) },
    );
    expect(resized).toMatchObject({ ok: true, width: 500, height: 250 });

    const orientedJpeg = await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 3,
        background: { r: 220, g: 40, b: 20 },
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    let orientedDataUri = "";
    const oriented = await uploadImage(
      {
        image_base64: `data:image/jpeg;base64,${orientedJpeg.toString("base64")}`,
      },
      config,
      { client: captureUpload((value) => (orientedDataUri = value)) },
    );
    expect(oriented).toMatchObject({ ok: true, width: 20, height: 40 });

    const transparent = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 20, g: 120, b: 220, alpha: 0.4 },
      },
    })
      .png()
      .toBuffer();
    let transparentDataUri = "";
    const alphaResult = await uploadImage(
      {
        image_base64: `data:image/png;base64,${transparent.toString("base64")}`,
      },
      config,
      { client: captureUpload((value) => (transparentDataUri = value)) },
    );
    expect(alphaResult.ok).toBe(true);
    expect(await imageMetadataFromDataUri(transparentDataUri)).toMatchObject({
      format: "png",
      hasAlpha: true,
    });
    expect(await imageMetadataFromDataUri(resizedDataUri)).toMatchObject({
      width: 500,
      height: 250,
    });
    expect(await imageMetadataFromDataUri(orientedDataUri)).toMatchObject({
      width: 20,
      height: 40,
    });
  });

  it("blocks image URLs that resolve to private addresses before fetch", async () => {
    let fetched = false;
    const result = await uploadImage(
      { image_url: "https://public-looking.example/image.png" },
      config,
      {
        dnsLookup: async () => [{ address: "169.254.169.254" }],
        fetchFn: async () => {
          fetched = true;
          return new Response();
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "REMOTE_IMAGE_BLOCKED",
        stage: "download",
      },
    });
    expect(fetched).toBe(false);
  });

  it("normalizes remote SVG and reports declared MIME mismatches", async () => {
    const remoteSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#fff"/><text x="10" y="45">Remote SVG</text></svg>';
    let remoteSvgDataUri = "";
    const svgResult = await uploadImage(
      { source_type: "url", image_url: "https://example.com/card.svg" },
      config,
      {
        dnsLookup: async () => [{ address: "2001:4860:4860::8888" }],
        fetchFn: async () =>
          new Response(remoteSvg, {
            headers: {
              "content-type": "image/svg+xml; charset=utf-8",
              "content-length": String(Buffer.byteLength(remoteSvg)),
            },
          }),
        client: captureUpload((value) => (remoteSvgDataUri = value)),
      },
    );

    expect(svgResult).toMatchObject({
      ok: true,
      source_type: "url",
      format: "png",
      width: 160,
      height: 80,
    });
    expect(await imageMetadataFromDataUri(remoteSvgDataUri)).toMatchObject({
      format: "png",
      width: 160,
      height: 80,
    });

    const mismatch = await uploadImage(
      { image_url: "https://example.com/mislabeled.jpg" },
      config,
      {
        fetchFn: async () =>
          new Response(Buffer.from(validPngBase64, "base64"), {
            headers: {
              "content-type": "image/jpeg",
              "content-length": "not-a-number",
            },
          }),
        client: captureUpload(() => undefined),
      },
    );
    expect(mismatch).toMatchObject({ ok: true, format: "png" });
    expect(mismatch.warnings).toContain(
      "Declared image MIME type image/jpeg did not match decoded type image/png; the decoded image was normalized safely.",
    );
  });

  it("returns explicit DNS resolution errors", async () => {
    const lookupFailed = await uploadImage(
      { image_url: "https://dns-error.example/image.png" },
      config,
      {
        dnsLookup: async () => {
          throw new Error("resolver unavailable");
        },
        fetchFn: async () => {
          throw new Error("fetch must not run");
        },
      },
    );
    expect(lookupFailed).toMatchObject({
      ok: false,
      errors: ["Image host DNS resolution failed."],
      error: { code: "REMOTE_IMAGE_DOWNLOAD_FAILED", stage: "download" },
    });

    const noAddresses = await uploadImage(
      { image_url: "https://dns-empty.example/image.png" },
      config,
      {
        dnsLookup: async () => [],
        fetchFn: async () => {
          throw new Error("fetch must not run");
        },
      },
    );
    expect(noAddresses).toMatchObject({
      ok: false,
      errors: ["Image host DNS resolution returned no addresses."],
      error: { code: "REMOTE_IMAGE_DOWNLOAD_FAILED", stage: "download" },
    });
  });

  it("rejects hostile and malformed SVG variants", async () => {
    const unsafeInputs = [
      "",
      `<svg xmlns="http://www.w3.org/2000/svg"><text>${"x".repeat(1_000_000)}</text></svg>`,
      '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>',
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><?unsafe value?></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>',
      '<html xmlns="http://www.w3.org/1999/xhtml"/>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://example.com/style.css);</style></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/shape.svg#item"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" xml:base="https://example.com/"/>',
    ];

    for (const svg of unsafeInputs) {
      const result = await uploadImage({ source_type: "svg", svg }, config);
      expect(result).toMatchObject({ ok: false });
      expect(["SVG_SANITIZATION_FAILED", "IMAGE_TOO_LARGE"]).toContain(
        result.error?.code,
      );
      expect(result.error?.stage).toBe("sanitization");
    }

    let localReferenceDataUri = "";
    const localReference = await uploadImage(
      {
        source_type: "svg",
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><defs><linearGradient id="local"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient><path id="shape" d="M0 0h20v20H0z"/></defs><style>.background{fill:url(#local)}</style><rect class="background" width="120" height="60"/><use href="#shape" fill="#fff"/></svg>',
      },
      config,
      { client: captureUpload((value) => (localReferenceDataUri = value)) },
    );
    expect(localReference).toMatchObject({ ok: true, width: 120, height: 60 });
    expect(await imageMetadataFromDataUri(localReferenceDataUri)).toMatchObject(
      {
        format: "png",
      },
    );
  });

  it("validates card inputs and supports safe defaults", async () => {
    const defaultCard = await uploadImage(
      {
        source_type: "card",
        card: {
          width: 640,
          height: 320,
          title:
            "A long title with ampersands & angle brackets < > and enough words to wrap across lines",
        },
      },
      config,
      { client: captureUpload(() => undefined) },
    );
    expect(defaultCard).toMatchObject({
      ok: true,
      source_type: "card",
      width: 640,
      height: 320,
    });

    for (const card of [
      { width: 0, height: 100, title: "Invalid width" },
      { width: 100, height: 0, title: "Invalid height" },
      { width: 1.5, height: 100, title: "Non-integer width" },
      { width: 100, height: 1.5, title: "Non-integer height" },
      { width: 6001, height: 100, title: "Excessive width" },
      { width: 100, height: 6001, title: "Excessive height" },
      { width: 6000, height: 6000, title: "Too many pixels" },
      { width: 100, height: 100, title: " " },
      {
        width: 100,
        height: 100,
        title: "Invalid background",
        background: "white",
      },
      {
        width: 100,
        height: 100,
        title: "Invalid foreground",
        foreground: "rgb(0, 0, 0)",
      },
    ]) {
      const result = await uploadImage({ source_type: "card", card }, config);
      expect(result).toMatchObject({ ok: false, error: { stage: "source" } });
    }
  });

  it("enforces decoded and normalized image limits and emits visual warnings", async () => {
    const animated = await uploadImage(
      {
        image_base64: `data:image/gif;base64,${animatedGifBase64}`,
      },
      config,
    );
    expect(animated).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_IMAGE_FORMAT", stage: "decode" },
    });

    const oversizedDimensions = await uploadImage(
      {
        source_type: "svg",
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="6001" height="1"/>',
      },
      config,
    );
    expect(oversizedDimensions).toMatchObject({
      ok: false,
      error: { code: "INVALID_DIMENSIONS", stage: "validation" },
    });

    const invalidSvgDimensions = await uploadImage(
      {
        source_type: "svg",
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="10"/>',
      },
      config,
    );
    expect(invalidSvgDimensions).toMatchObject({
      ok: false,
      error: { code: "SVG_RENDER_FAILED", stage: "decode" },
    });

    const invalidResize = await uploadImage(
      {
        image_base64: `data:image/png;base64,${validPngBase64}`,
        max_width: 0,
      },
      config,
    );
    expect(invalidResize).toMatchObject({
      ok: false,
      error: { code: "INVALID_DIMENSIONS", stage: "source" },
    });

    const raw = Buffer.alloc(64 * 64 * 3);
    for (let index = 0; index < raw.length; index += 1) {
      raw[index] = (index * 73 + index * index) % 256;
    }
    const compressedJpeg = await sharp(raw, {
      raw: { width: 64, height: 64, channels: 3 },
    })
      .jpeg({ quality: 1 })
      .toBuffer();
    expect(compressedJpeg.byteLength).toBeLessThan(500);
    const normalizedTooLarge = await uploadImage(
      {
        image_base64: `data:image/jpeg;base64,${compressedJpeg.toString("base64")}`,
      },
      { ...config, maxImageBytes: 500 },
    );
    expect(normalizedTooLarge).toMatchObject({
      ok: false,
      error: { code: "IMAGE_TOO_LARGE", stage: "validation" },
    });

    const tiff = await sharp({
      create: {
        width: 40,
        height: 40,
        channels: 3,
        background: { r: 40, g: 80, b: 120 },
      },
    })
      .tiff()
      .toBuffer();
    const unsupportedDecodedFormat = await uploadImage(
      {
        image_base64: `data:image/png;base64,${tiff.toString("base64")}`,
      },
      config,
    );
    expect(unsupportedDecodedFormat).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_IMAGE_FORMAT", stage: "decode" },
    });

    const transparentStrip = await sharp({
      create: {
        width: 320,
        height: 20,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const warnings = await uploadImage(
      {
        image_base64: `data:image/png;base64,${transparentStrip.toString("base64")}`,
      },
      config,
      { client: captureUpload(() => undefined) },
    );
    expect(warnings.ok).toBe(true);
    expect(warnings.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unusually small"),
        expect.stringContaining("unusual 320:20 aspect ratio"),
        expect.stringContaining("almost entirely transparent"),
        expect.stringContaining("almost entirely one color"),
      ]),
    );
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
      errors: [
        "Exactly one image source is required: image_file, image_url, image_base64, svg, or card.",
      ],
      error: {
        code: "EXACTLY_ONE_IMAGE_SOURCE_REQUIRED",
        stage: "source",
      },
    });

    await expect(
      uploadImage(
        {
          source_type: "svg",
          image_base64: `data:image/png;base64,${validPngBase64}`,
        },
        config,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "EXACTLY_ONE_IMAGE_SOURCE_REQUIRED",
        stage: "source",
      },
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
      errors: [
        "Exactly one image source is required: image_file, image_url, image_base64, svg, or card.",
      ],
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
          image_base64: "aGk=",
          filename_hint: "image.png",
        },
        config,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "IMAGE_DECODE_FAILED", stage: "decode" },
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

  it("exposes exact file input while rejecting the ambiguous legacy file_path field", () => {
    expect(
      UploadImageInputSchema.safeParse({
        source_type: "svg",
        svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        output_format: "png",
      }).success,
    ).toBe(true);
    expect(
      UploadImageInputSchema.safeParse({
        source_type: "file",
        image_file: "/tmp/image.png",
      }).success,
    ).toBe(true);
    expect(
      UploadImageInputSchema.safeParse({
        source_type: "file",
        file_path: "/tmp/image.png",
      }).success,
    ).toBe(false);
    expect(
      UploadImageInputSchema.safeParse({
        source_type: "svg",
        svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        output_format: "jpeg",
      }).success,
    ).toBe(false);
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

    const fetchNoBody = await uploadImage(
      {
        image_url: "https://example.com/empty.png",
      },
      config,
      {
        fetchFn: async () =>
          new Response(null, {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
      },
    );
    expect(fetchNoBody).toMatchObject({
      ok: false,
      error: { code: "IMAGE_DECODE_FAILED", stage: "decode" },
    });

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

    const unsafeContentLength = await uploadImage(
      {
        image_url: "https://example.com/unsafe-content-length.png",
      },
      config,
      {
        fetchFn: async () =>
          new Response(Buffer.from(validPngBase64, "base64"), {
            status: 200,
            headers: {
              "content-type": "image/png",
              "content-length": "999999999999999999999999999999999999",
            },
          }),
        client: captureUpload(() => undefined),
      },
    );
    expect(unsafeContentLength.ok).toBe(true);

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

    const fetchRejectedWithoutError = await uploadImage(
      {
        image_url: "https://example.com/non-error-rejection.png",
      },
      config,
      {
        fetchFn: () => Promise.reject(),
      },
    );
    expect(fetchRejectedWithoutError.errors).toEqual([
      "Remote image download failed.",
    ]);

    const fetchEmptyError = await uploadImage(
      {
        image_url: "https://example.com/empty-error.png",
      },
      config,
      {
        fetchFn: async () => {
          throw new Error("");
        },
      },
    );
    expect(fetchEmptyError.errors).toEqual(["Remote image download failed."]);

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
        image_base64: `data:image/png;base64,${validPngBase64}`,
      },
      config,
    );
    expect(configError.errors).toEqual([
      "SUBSTACK_PUBLICATION_URL is required.",
    ]);

    const apiError = await uploadImage(
      {
        image_base64: `data:image/png;base64,${validPngBase64}`,
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

function dataUriBytes(dataUri: string): Buffer {
  const base64 = dataUri.split(",", 2)[1];
  if (!base64) {
    throw new Error("Expected a base64 image data URI.");
  }
  return Buffer.from(base64, "base64");
}

async function imageMetadataFromDataUri(dataUri: string) {
  return sharp(dataUriBytes(dataUri)).metadata();
}

function captureUpload(setDataUri: (value: string) => void) {
  return {
    uploadImage: async (dataUri: string) => {
      setDataUri(dataUri);
      return { url: "https://substackcdn.com/captured.png" };
    },
  };
}
