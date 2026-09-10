import type { IncomingMessage, ServerResponse } from "node:http";

export const ROBOTS_TXT = [
  "User-agent: *",
  "Allow: /",
  "Disallow: /admin",
  "Disallow: /admin/",
  "Disallow: /sponsor",
  "Disallow: /sponsor/",
  "Disallow: /manage",
  "Disallow: /manage/",
  "Disallow: /api",
  "Disallow: /api/",
  "",
].join("\n");

export const SITEMAP_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>',
  "",
].join("\n");

const ROBOTS_CONTENT_TYPE = "text/plain; charset=utf-8";
const XML_CONTENT_TYPE = "application/xml; charset=utf-8";

type Next = (error?: unknown) => void;

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://vite.local").pathname;
}

export function crawlerResponsesMiddleware(
  request: IncomingMessage,
  response: ServerResponse,
  next: Next,
): void {
  const pathname = requestPath(request);

  if (pathname === "/robots.txt") {
    response.statusCode = 200;
    response.setHeader("Content-Type", ROBOTS_CONTENT_TYPE);
    response.end(ROBOTS_TXT);
    return;
  }

  if (pathname === "/sitemap.xml") {
    response.statusCode = 200;
    response.setHeader("Content-Type", XML_CONTENT_TYPE);
    response.end(SITEMAP_XML);
    return;
  }

  next();
}
