import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => {
  const column = {};
  const table = new Proxy({}, { get: () => column });
  return {
    db: {},
    sponsorActivityTable: table,
    sponsorAssetsTable: table,
    sponsorDocumentsTable: table,
    sponsorPresentersTable: table,
    sponsorSessionsTable: table,
    sponsorTasksTable: table,
  };
});

vi.mock("./logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import {
  isSafeRasterPreview,
  SponsorAssetValidationError,
  validateSponsorAssetFile,
} from "./sponsor-assets";
import { MemorySponsorObjectStorage, sponsorObjectKey } from "./sponsor-storage";

function upload(originalname: string, mimetype: string, buffer: Buffer) {
  return { originalname, mimetype, size: buffer.length, buffer };
}

function ooxml(root: "ppt" | "word", macro = false): Buffer {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(
      `[Content_Types].xml\0${root}/document.xml\0${macro ? `${root}/vbaProject.bin` : ""}`,
      "latin1",
    ),
  ]);
}

afterEach(() => {
  delete process.env.SPONSOR_STORAGE_PREFIX;
});

describe("sponsor asset validation", () => {
  it("accepts a real PNG signature and computes its checksum", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const result = validateSponsorAssetFile(upload("logo.png", "image/png", png));
    expect(result.extension).toBe(".png");
    expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a renamed file whose signature does not match", () => {
    expect(() =>
      validateSponsorAssetFile(upload("logo.png", "image/png", Buffer.from("not a png"))),
    ).toThrow(SponsorAssetValidationError);
  });

  it("accepts the correct OOXML root and blocks embedded VBA", () => {
    expect(() =>
      validateSponsorAssetFile(
        upload(
          "slides.pptx",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          ooxml("ppt"),
        ),
      ),
    ).not.toThrow();
    expect(() =>
      validateSponsorAssetFile(
        upload(
          "slides.pptx",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          ooxml("ppt", true),
        ),
      ),
    ).toThrow("file signature does not match");
  });

  it("blocks macro-enabled Office extensions and active SVG content", () => {
    expect(() =>
      validateSponsorAssetFile(upload("slides.pptm", "application/octet-stream", ooxml("ppt"))),
    ).toThrow("Executable and macro-enabled files are not accepted");
    expect(() =>
      validateSponsorAssetFile(
        upload("logo.svg", "image/svg+xml", Buffer.from("<svg><script>alert(1)</script></svg>")),
      ),
    ).toThrow("file signature does not match");
  });

  it("only allows safe raster MIME types to render inline", () => {
    expect(isSafeRasterPreview("image/png")).toBe(true);
    expect(isSafeRasterPreview("application/pdf")).toBe(false);
    expect(isSafeRasterPreview("image/svg+xml")).toBe(false);
  });
});

describe("sponsor storage abstraction", () => {
  it("stores bytes without exposing a public object URL", async () => {
    const storage = new MemorySponsorObjectStorage();
    const key = sponsorObjectKey(12, "asset-abc", 3);
    await storage.put(key, Buffer.from("sponsor file"));
    expect(await storage.exists(key)).toBe(true);

    const chunks: Buffer[] = [];
    for await (const chunk of storage.stream(key)) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).toBe("sponsor file");

    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
  });

  it("uses the deterministic preview/test prefix when configured", () => {
    process.env.SPONSOR_STORAGE_PREFIX = "/preview/run-42/";
    expect(sponsorObjectKey(7, "asset-id", 1)).toBe("preview/run-42/sponsors/7/asset-id/1");
  });
});
