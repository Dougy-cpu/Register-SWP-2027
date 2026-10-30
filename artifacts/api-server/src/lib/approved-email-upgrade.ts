import { createHash } from "node:crypto";
import { approvedEmailTemplates } from "./approved-email-design";

// Exact production templates reviewed on 30 October 2026. Unknown edits stop the upgrade.
export const reviewedEmailTemplates = {
  confirmation: {
    subject: "Booking Confirmed — {{orderReference}} — SWP Summit 2027",
    sha256: "03574b0a88bd92eea69c81abe513a5b84e2d89188ce145a86727b19682084311",
  },
  welcome: {
    subject: "Welcome to SWP Summit 2027 — We Can't Wait to See You!",
    sha256: "4c76bd74dbce4903b158a78a4a87aa5d30264ce58c957c49e472692797d019a6",
  },
};

export function emailTemplateHash(html: string): string {
  return createHash("sha256").update(html, "utf8").digest("hex");
}
export interface StoredEmailTemplate {
  id: number;
  type: string;
  subject: string;
  htmlBody: string;
}

export function planApprovedEmailUpgrade(rows: StoredEmailTemplate[]) {
  return (
    Object.keys(approvedEmailTemplates) as Array<keyof typeof approvedEmailTemplates>
  ).flatMap((type) => {
    const current = rows.find((row) => row.type === type);
    if (!current)
      throw new Error(`${type} template is missing; review the database before upgrading.`);
    const target = approvedEmailTemplates[type];
    if (current.htmlBody === target.htmlBody && current.subject === target.subject) return [];
    const reviewed = reviewedEmailTemplates[type];
    if (
      emailTemplateHash(current.htmlBody) !== reviewed.sha256 ||
      current.subject !== reviewed.subject
    ) {
      throw new Error(
        `${type} template differs from the reviewed version; no templates were changed.`,
      );
    }
    return [{ current, target }];
  });
}
