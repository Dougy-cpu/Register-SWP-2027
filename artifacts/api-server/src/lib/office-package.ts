import { crc32, inflateRawSync } from "node:zlib";

// Restricted to the small, single-disk, unencrypted ZIP packages accepted by sponsor uploads.
// Inspect both directories and the actual inflated bytes. Never extract to the filesystem.
const MAX_ENTRIES = 4096;
const MAX_EXPANDED = 128 * 1024 * 1024;
const MAX_PART = 64 * 1024 * 1024;
const MAX_XML = 16 * 1024 * 1024;
const requiredXml = ["[Content_Types].xml", "_rels/.rels"];
const utf8 = new TextDecoder("utf-8", { fatal: true });

function invalid(): never {
  throw new Error("Invalid Office package");
}

function packageParts(file: Buffer, main: string) {
  if (file.length < 22 || file.readUInt32LE(0) !== 0x04034b50) invalid();
  const end = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), file.length - 22);
  if (
    end < 0 ||
    end + 22 + file.readUInt16LE(end + 20) !== file.length ||
    file.readUInt32LE(end + 4) !== 0
  )
    invalid();
  const count = file.readUInt16LE(end + 10),
    central = file.readUInt32LE(end + 16);
  if (
    !count ||
    count > MAX_ENTRIES ||
    file.readUInt16LE(end + 8) !== count ||
    central + file.readUInt32LE(end + 12) !== end
  )
    invalid();
  const names = new Set<string>(),
    parts = new Map<string, string>(),
    ranges: Array<[number, number]> = [];
  let pos = central,
    total = 0;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > end || file.readUInt32LE(pos) !== 0x02014b50) invalid();
    const flags = file.readUInt16LE(pos + 8),
      method = file.readUInt16LE(pos + 10);
    const compressed = file.readUInt32LE(pos + 20),
      expanded = file.readUInt32LE(pos + 24);
    const nameLen = file.readUInt16LE(pos + 28),
      extra = file.readUInt16LE(pos + 30),
      comment = file.readUInt16LE(pos + 32);
    const local = file.readUInt32LE(pos + 42),
      next = pos + 46 + nameLen + extra + comment;
    total += expanded;
    if (
      next > end ||
      !nameLen ||
      file.readUInt16LE(pos + 34) !== 0 ||
      flags & ~0x080e ||
      ![0, 8].includes(method) ||
      expanded > MAX_PART ||
      total > MAX_EXPANDED ||
      local + 30 > central ||
      file.readUInt32LE(local) !== 0x04034b50
    )
      invalid();
    const name = utf8.decode(file.subarray(pos + 46, pos + 46 + nameLen)),
      folded = name.toLowerCase();
    if (
      names.has(folded) ||
      name.startsWith("/") ||
      /[\\:\x00-\x1f]/.test(name) ||
      name.split("/").some((x) => x === "." || x === "..") ||
      /(?:^|\/)(?:vbaProject[^/]*|[^/]+\.(?:exe|dll|cmd|bat|ps1|docm|pptm))$/i.test(name)
    )
      invalid();
    names.add(folded);
    const localNameLen = file.readUInt16LE(local + 26),
      start = local + 30 + localNameLen + file.readUInt16LE(local + 28);
    if (
      file.readUInt16LE(local + 6) !== flags ||
      file.readUInt16LE(local + 8) !== method ||
      start + compressed > central ||
      !file
        .subarray(local + 30, local + 30 + localNameLen)
        .equals(file.subarray(pos + 46, pos + 46 + nameLen))
    )
      invalid();
    ranges.push([local, start + compressed]);
    const packed = file.subarray(start, start + compressed);
    const bytes =
      method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, expanded) });
    if (bytes.length !== expanded || crc32(bytes) !== file.readUInt32LE(pos + 16)) invalid();
    if (name === main || requiredXml.includes(name)) {
      if (bytes.length > MAX_XML || (name !== main && bytes.length > 2 * 1024 * 1024)) invalid();
      parts.set(name, utf8.decode(bytes));
    }
    pos = next;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((r, i) => i > 0 && r[0] < ranges[i - 1][1]) || pos !== end || parts.size !== 3)
    invalid();
  return parts;
}

// Parse the small XML vocabulary used for package declarations. Reject DTDs, unknown
// entities and malformed nesting; Office content is never executed or rendered.
type Element = { name: string; attributes: Map<string, string> };
function walkXml(xml: string, visit: (element: Element, depth: number) => void) {
  const stack: string[] = [];
  let cursor = 0,
    rootSeen = false;
  const tag =
    /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
  const entity = /&(#\d+|#x[\da-fA-F]+|amp|quot|apos|lt|gt);/g;
  function unescape(value: string) {
    if (value.replace(entity, "").includes("&")) invalid();
    return value.replace(entity, (_all, key: string) => {
      if (key[0] !== "#")
        return ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" } as Record<string, string>)[
          key
        ];
      const code = key[1] === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      if (
        !Number.isInteger(code) ||
        code > 0x10ffff ||
        code === 0 ||
        (code >= 0xd800 && code <= 0xdfff)
      )
        invalid();
      return String.fromCodePoint(code);
    });
  }
  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor);
    const body = xml.slice(cursor, open === -1 ? xml.length : open);
    if (!stack.length && body.trim()) invalid();
    if (body.includes("&")) unescape(body);
    if (open === -1) break;
    const special = xml.startsWith("<!--", open)
      ? "-->"
      : xml.startsWith("<?", open)
        ? "?>"
        : xml.startsWith("<![CDATA[", open) && stack.length
          ? "]]>"
          : null;
    if (special) {
      const close = xml.indexOf(special, open + 2);
      if (close < 0) invalid();
      cursor = close + special.length;
      continue;
    }
    tag.lastIndex = open;
    const found = tag.exec(xml);
    if (!found) invalid();
    const [, closing, name, attributes, empty] = found;
    cursor = tag.lastIndex;
    if (closing) {
      if (empty || attributes || stack.pop() !== name) invalid();
      continue;
    }
    if (!stack.length) {
      if (rootSeen) invalid();
      rootSeen = true;
    }
    if (stack.length > 256) invalid();
    const attrs = new Map<string, string>();
    for (const match of attributes.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      if (attrs.has(match[1])) invalid();
      attrs.set(match[1], unescape(match[2] ?? match[3]));
    }
    visit({ name, attributes: attrs }, stack.length);
    if (!empty) stack.push(name);
  }
  if (!rootSeen || stack.length) invalid();
}

function checkRoot(el: Element, localName: string, namespaces: string[]) {
  const names = el.name.split(":");
  const local = names.at(-1),
    ns = el.attributes.get(names.length === 1 ? "xmlns" : "xmlns:" + names[0]);
  if (names.length > 2 || local !== localName || !ns || !namespaces.includes(ns)) invalid();
}

export function isOfficePackage(file: Buffer, folder: "word" | "ppt"): boolean {
  try {
    const word = folder === "word";
    const main = word ? "word/document.xml" : "ppt/presentation.xml";
    const type = word ? "wordprocessingml" : "presentationml";
    const xml = packageParts(file, main);
    const contentNs = "http://schemas.openxmlformats.org/package/2006/content-types";
    const relNs = "http://schemas.openxmlformats.org/package/2006/relationships";
    let declared = false,
      linked = false;
    walkXml(xml.get(requiredXml[0])!, (el, d) => {
      if (d === 0) checkRoot(el, "Types", [contentNs]);
      const mime = el.attributes.get("ContentType") ?? "";
      if (/macroenabled|vbaproject|vbadata/i.test(mime)) invalid();
      if (
        d === 1 &&
        el.name.split(":").at(-1) === "Override" &&
        el.attributes.get("PartName") === "/" + main &&
        mime ===
          `application/vnd.openxmlformats-officedocument.${type}.${word ? "document" : "presentation"}.main+xml`
      )
        declared = true;
    });
    walkXml(xml.get(requiredXml[1])!, (el, d) => {
      if (d === 0) checkRoot(el, "Relationships", [relNs]);
      if (
        d === 1 &&
        el.name.split(":").at(-1) === "Relationship" &&
        [
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
          "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
        ].includes(el.attributes.get("Type") ?? "") &&
        (el.attributes.get("Target") ?? "").replace(/^\//, "") === main &&
        el.attributes.get("TargetMode") !== "External"
      )
        linked = true;
    });
    walkXml(xml.get(main)!, (el, d) => {
      if (d === 0)
        checkRoot(el, word ? "document" : "presentation", [
          `http://schemas.openxmlformats.org/${type}/2006/main`,
          `http://purl.oclc.org/ooxml/${type}/main`,
        ]);
    });
    return declared && linked;
  } catch {
    return false;
  }
}
