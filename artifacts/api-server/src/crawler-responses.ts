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

function sendRobots(_request: Request, response: Response) {
  response.type("text/plain").send(ROBOTS_TXT);
}

function sendMissingSitemap(_request: Request, response: Response) {
  response.status(404).type("text/plain").send("Sitemap not found.\n");
}

export function registerCrawlerResponses(app: Express) {
  app.get("/robots.txt", sendRobots);
  app.get("/sitemap.xml", sendMissingSitemap);
}