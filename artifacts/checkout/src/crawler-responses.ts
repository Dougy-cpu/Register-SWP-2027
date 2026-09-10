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

const SITEMAP_NOT_FOUND = "Sitemap not found.\n";
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

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
    response.setHeader("Content-Type", TEXT_CONTENT_TYPE);
    response.end(ROBOTS_TXT);
    return;
  }

  if (pathname === "/sitemap.xml") {
    response.statusCode = 404;
    response.setHeader("Content-Type", TEXT_CONTENT_TYPE);
    response.end(SITEMAP_NOT_FOUND);
    return;
  }

  next();
}