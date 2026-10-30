import sharp from "sharp";
import { logger } from "./logger";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1600;

async function emailPngDataUrl(source: string): Promise<string | null> {
  try {
    // Uploads from the branding screen and template editor use FileReader data URLs.
    // Only decode embedded bytes here; never fetch URLs from email HTML.
    const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(source);
    if (!match || match[1].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
      throw new Error("Invalid or oversized embedded email image");
    }

    const png = await sharp(Buffer.from(match[1], "base64"), {
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: "error",
    })
      .rotate()
      .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .timeout({ seconds: 5 })
      .toBuffer();

    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    // Optional branding must not prevent a booking confirmation from being delivered.
    // Do not log the source: templates can contain large or private image payloads.
    logger.warn("Embedded email image could not be prepared; using its alternative text");
    return null;
  }
}

/** Prepare uploaded images for email clients without changing browser previews or stored originals. */
export async function prepareInlineEmailImages(html: string): Promise<string> {
  const converted = new Map<string, string | null>();
  const images = html.matchAll(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi);
  let prepared = "";
  let offset = 0;

  for (const image of images) {
    const tag = image[0];
    const source = /\ssrc\s*=\s*(["'])(data:image\/[^"']*)\1/i.exec(tag);
    if (!source) continue;

    const dataUrl = source[2];
    if (!converted.has(dataUrl)) converted.set(dataUrl, await emailPngDataUrl(dataUrl));
    const pngDataUrl = converted.get(dataUrl);
    const alt = /\salt\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2] ?? "";
    // Retain escaped entities already in the alt attribute, but never emit markup from it.
    const fallback = alt.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const replacement = pngDataUrl
      ? tag.replace(source[0], source[0].replace(dataUrl, pngDataUrl))
      : fallback;

    prepared += html.slice(offset, image.index) + replacement;
    offset = image.index + tag.length;
  }

  return prepared + html.slice(offset);
}
