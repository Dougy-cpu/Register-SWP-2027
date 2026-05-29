import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.get("/company-info", (_req, res): void => {
  const assetPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "assets",
    "company-info.pdf",
  );

  if (!existsSync(assetPath)) {
    res.status(404).json({ error: "Company information PDF not found" });
    return;
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'inline; filename="DBL-company-information.pdf"');
  res.sendFile(assetPath);
});

export default router;
