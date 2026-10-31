import { promisify } from "node:util";
import { crc32, inflateRaw } from "node:zlib";
import unzipper from "unzipper";
import { SaxesParser, type SaxesTagNS } from "saxes";

const inflate = promisify(inflateRaw);
const MAX_ENTRIES = 4096;
const MAX_EXPANDED = 128 * 1024 * 1024;
const MAX_PART = 64 * 1024 * 1024;
const MAX_XML = 16 * 1024 * 1024;
const CONTENTS = "[Content_Types].xml";
const RELS = "_rels/.rels";
const CONTENT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const utf8 = new TextDecoder("utf-8", { fatal: true });

function invalid(): never {
  throw new Error("Invalid Office package");
}

// Check record boundaries before the ZIP reader consumes an untrusted directory.
function checkExtra(file: Buffer, start: number, end: number) {
  if (end > file.length) invalid();
  for (let pos = start; pos < end; ) {
    if (pos + 4 > end) invalid();
    pos += 4 + file.readUInt16LE(pos + 2);
    if (pos > end) invalid();
  }
}

function readDirectoryBounds(file: Buffer) {
  if (file.length < 22 || file.readUInt32LE(0) !== 0x04034b50) invalid();
  const end = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), file.length - 22);
  if (
    end < 0 ||
    end + 22 + file.readUInt16LE(end + 20) !== file.length ||
    file.readUInt32LE(end + 4) !== 0
  )
    invalid();
  const count = file.readUInt16LE(end + 10);
  const central = file.readUInt32LE(end + 16);
  if (
    !count ||
    count > MAX_ENTRIES ||
    file.readUInt16LE(end + 8) !== count ||
    central + file.readUInt32LE(end + 12) !== end
  )
    invalid();
  let pos = central;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > end || file.readUInt32LE(pos) !== 0x02014b50) invalid();
    const extra = pos + 46 + file.readUInt16LE(pos + 28);
    const extraEnd = extra + file.readUInt16LE(pos + 30);
    const next = extraEnd + file.readUInt16LE(pos + 32);
    if (next > end || file.readUInt16LE(pos + 34) !== 0) invalid();
    checkExtra(file, extra, extraEnd);
    pos = next;
  }
  if (pos !== end) invalid();
  return { central, count, tailSize: file.length - end };
}

function decodeXml(bytes: Buffer): string {
  const first = bytes[0],
    second = bytes[1];
  if ((first === 0xff && second === 0xfe) || (first === 0x3c && second === 0))
    return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  if ((first === 0xfe && second === 0xff) || (first === 0 && second === 0x3c))
    return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
  return utf8.decode(bytes);
}

async function packageParts(file: Buffer, main: string) {
  const { central, count, tailSize } = readDirectoryBounds(file);
  const { files } = await unzipper.Open.buffer(file, { tailSize });
  if (files.length !== count) invalid();
  const names = new Set<string>();
  const parts = new Map<string, string>();
  const ranges: Array<[number, number]> = [];
  let total = 0;
  for (const entry of files) {
    const {
      flags,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      offsetToLocalFileHeader: local,
    } = entry;
    const name = utf8.decode(entry.pathBuffer);
    const folded = name.toLowerCase();
    if (
      !name ||
      names.has(folded) ||
      name.startsWith("/") ||
      /[\\:]/.test(name) ||
      [...name].some((c) => c.charCodeAt(0) < 32) ||
      name.split("/").some((p) => p === "." || p === "..") ||
      /(?:^|\/)(?:vbaProject[^/]*|[^/]+\.(?:exe|dll|cmd|bat|ps1|docm|pptm))$/i.test(name)
    )
      invalid();
    names.add(folded);
    total += uncompressedSize;
    if (
      ![local, compressedSize, uncompressedSize].every(Number.isSafeInteger) ||
      flags & ~0x080e ||
      ![0, 8].includes(compressionMethod) ||
      uncompressedSize > MAX_PART ||
      total > MAX_EXPANDED ||
      local + 30 > central ||
      file.readUInt32LE(local) !== 0x04034b50
    )
      invalid();
    const localNameEnd = local + 30 + file.readUInt16LE(local + 26);
    const start = localNameEnd + file.readUInt16LE(local + 28);
    const end = start + compressedSize;
    if (
      file.readUInt16LE(local + 6) !== flags ||
      file.readUInt16LE(local + 8) !== compressionMethod ||
      end > central ||
      !file.subarray(local + 30, localNameEnd).equals(entry.pathBuffer)
    )
      invalid();
    // With a data descriptor, local checksums and sizes may be zero until the entry closes.
    const deferred = Boolean(flags & 8);
    const localValues = [
      file.readUInt32LE(local + 14),
      file.readUInt32LE(local + 18),
      file.readUInt32LE(local + 22),
    ];
    const declaredValues = [entry.crc32, compressedSize, uncompressedSize];
    if (localValues.some((value, i) => !(deferred && value === 0) && value !== declaredValues[i]))
      invalid();
    checkExtra(file, localNameEnd, start);
    ranges.push([local, end]);
    const keep = name === main || name === CONTENTS || name === RELS;
    if (keep && uncompressedSize > (name === main ? MAX_XML : 2 * 1024 * 1024)) invalid();
    // Inflate off the request thread with a native output limit, even if a hostile
    // archive understated the expanded size in both headers.
    const packed = file.subarray(start, end);
    const bytes =
      compressionMethod === 0
        ? packed
        : await inflate(packed, { maxOutputLength: Math.max(uncompressedSize, 1) });
    if (bytes.length !== uncompressedSize || crc32(bytes) !== entry.crc32) invalid();
    if (keep) parts.set(name, decodeXml(bytes));
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (parts.size !== 3 || ranges.some((range, i) => i > 0 && range[0] < ranges[i - 1][1]))
    invalid();
  return parts;
}

function readXml(
  xml: string,
  root: string,
  namespaces: string[],
  visit?: (node: SaxesTagNS, depth: number) => void,
) {
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0;
  parser.on("doctype", invalid);
  parser.on("opentag", (node) => {
    if (!depth && (node.local !== root || !namespaces.includes(node.uri))) invalid();
    if (depth > 256) invalid();
    visit?.(node, depth);
    depth++;
  });
  parser.on("closetag", () => {
    depth--;
  });
  parser.write(xml).close();
}

export async function isOfficePackage(file: Buffer, folder: "word" | "ppt"): Promise<boolean> {
  try {
    const word = folder === "word";
    const root = word ? "document" : "presentation";
    const main = folder + "/" + root + ".xml";
    const type = word ? "wordprocessingml" : "presentationml";
    const parts = await packageParts(file, main);
    let declared = false,
      linked = false;
    readXml(parts.get(CONTENTS)!, "Types", [CONTENT_NS], (node, depth) => {
      const mime = node.attributes.ContentType?.value ?? "";
      if (/macroenabled|vbaproject|vbadata/i.test(mime)) invalid();
      if (
        depth === 1 &&
        node.uri === CONTENT_NS &&
        node.local === "Override" &&
        node.attributes.PartName?.value === "/" + main &&
        mime === "application/vnd.openxmlformats-officedocument." + type + "." + root + ".main+xml"
      )
        declared = true;
    });
    readXml(parts.get(RELS)!, "Relationships", [REL_NS], (node, depth) => {
      const mode = node.attributes.TargetMode?.value;
      if (
        depth === 1 &&
        node.uri === REL_NS &&
        node.local === "Relationship" &&
        [
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
          "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
        ].includes(node.attributes.Type?.value ?? "") &&
        (node.attributes.Target?.value ?? "").replace(/^\//, "") === main &&
        (!mode || mode === "Internal")
      )
        linked = true;
    });
    readXml(parts.get(main)!, root, [
      "http://schemas.openxmlformats.org/" + type + "/2006/main",
      "http://purl.oclc.org/ooxml/" + type + "/main",
    ]);
    return declared && linked;
  } catch {
    return false;
  }
}
