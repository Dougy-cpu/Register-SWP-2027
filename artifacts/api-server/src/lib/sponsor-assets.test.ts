import archiver from "archiver";
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

async function ooxml(root: "ppt" | "word", macro = false, malformed = false): Promise<Buffer> {
  const archive = archiver("zip"),
    chunks: Buffer[] = [];
  const complete = new Promise<Buffer>((resolve, reject) => {
    archive.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    archive.once("end", () => resolve(Buffer.concat(chunks)));
    archive.once("error", reject);
  });
  const type = root === "ppt" ? "presentationml" : "wordprocessingml";
  const element = root === "ppt" ? "presentation" : "document",
    main = root + "/" + element + ".xml";
  archive.append(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${type}.${element}.main+xml"/></Types>`,
    { name: "[Content_Types].xml" },
  );
  archive.append(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="${main}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/></Relationships>`,
    { name: "_rels/.rels" },
  );
  archive.append(
    malformed
      ? "<unclosed>"
      : `<t:${element} xmlns:t="http://schemas.openxmlformats.org/${type}/2006/main"/>`,
    { name: main },
  );
  if (macro) archive.append(Buffer.from([1, 2, 3]), { name: root + "/vbaProject.bin" });
  void archive.finalize().catch((error) => archive.emit("error", error));
  return complete;
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

  it.each(["ppt", "word"] as const)(
    "accepts an actual %s package and rejects broken archives, XML and VBA",
    async (root) => {
      const doc = root === "word",
        name = doc ? "material.docx" : "slides.pptx";
      const mime =
        "application/vnd.openxmlformats-officedocument." +
        (doc ? "wordprocessingml.document" : "presentationml.presentation");
      const valid = await ooxml(root),
        macro = await ooxml(root, true),
        malformed = await ooxml(root, false, true);
      expect(validateSponsorAssetFile(upload(name, mime, valid)).extension).toBe(
        doc ? ".docx" : ".pptx",
      );
      for (const bytes of [
        macro,
        malformed,
        valid.subarray(0, valid.length - 12),
        Buffer.from("PK\\x03\\x04 [Content_Types].xml ppt/"),
      ]) {
        expect(() => validateSponsorAssetFile(upload(name, mime, bytes))).toThrow(
          "file signature does not match",
        );
      }
    },
  );

  it("blocks macro-enabled Office extensions and active SVG content", async () => {
    const slides = await ooxml("ppt");
    expect(() =>
      validateSponsorAssetFile(upload("slides.pptm", "application/octet-stream", slides)),
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
