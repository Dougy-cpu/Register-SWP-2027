import type { Express, Request, Response } from "express";

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

function sendRobots(_request: Request, response: Response) {
  response.type("text/plain").send(ROBOTS_TXT);
}

function sendSitemap(_request: Request, response: Response) {
  response.status(200).type("application/xml").send(SITEMAP_XML);
}

export function registerCrawlerResponses(app: Express) {
  app.get("/robots.txt", sendRobots);
  app.get("/sitemap.xml", sendSitemap);
}
