import ExcelJS from "exceljs";
import type { LeadListRow } from "./lead-scanner";
export type ReportRep = { id: string; name: string; scans: number };
export type ReportSponsor = {
  sponsorId: number;
  sponsorCompany: string;
  scans: number;
  people: number;
  reps: ReportRep[];
};
export interface ReportRoster {
  sponsorId: number;
  sponsorCompany: string;
  staff: { id: string; name: string }[];
}
export function scannerReport(
  leads: LeadListRow[],
  rosters: ReportRoster[] = [],
  asOf = new Date().toISOString(),
) {
  const groups = new Map<number, ReportSponsor>();
  const group = (id: number, name: string) => {
    let entry = groups.get(id);
    if (!entry) {
      entry = { sponsorId: id, sponsorCompany: name, scans: 0, people: 0, reps: [] };
      groups.set(id, entry);
    }
    return entry;
  };
  for (const r of rosters) {
    const g = group(r.sponsorId, r.sponsorCompany);
    g.reps = r.staff.map((s) => ({ ...s, scans: 0 }));
  }
  const details = [];
  for (const lead of leads) {
    const g = group(lead.sponsorId, lead.sponsorCompany);
    g.people++;
    const seen = new Set<string>();
    for (const scan of [...lead.scans].sort(
      (a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id),
    )) {
      if (seen.has(scan.operatorId)) continue;
      seen.add(scan.operatorId);
      g.scans++;
      let rep = g.reps.find((r) => r.id === scan.operatorId);
      if (!rep) {
        rep = { id: scan.operatorId, name: scan.operatorName, scans: 0 };
        g.reps.push(rep);
      }
      rep.scans++;
      const note = lead.notes
        .filter((n) => n.operatorId === rep.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
      details.push({
        Sponsor: g.sponsorCompany,
        "Rep ID": rep.id,
        Representative: rep.name,
        "Attendee ID": lead.attendeeId,
        Name: lead.name,
        "Job Title": lead.jobTitle,
        Company: lead.company,
        "Work Email": lead.workEmail,
        "First scan (UTC)": scan.capturedAt,
        Rating: note?.rating ?? "",
        "Rep note": note?.note ?? "",
      });
    }
  }
  const companies = [...groups.values()].sort((a, b) =>
    a.sponsorCompany.localeCompare(b.sponsorCompany),
  );
  for (const g of companies)
    g.reps.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { asOf, companies, details };
}
export function reportWorkbook(
  report: ReturnType<typeof scannerReport>,
  contactRows: Record<string, string | number>[],
  contactHeaders: string[],
) {
  const book = new ExcelJS.Workbook();
  book.creator = "SWP Summit 2027";
  const summary = book.addWorksheet("Summary");
  summary.addRow(["Sponsor scanner report"]);
  summary.addRow(["Confirmed as of (UTC)", report.asOf]);
  summary.addRow([
    "Pending, rejected and rehearsal scans are excluded. A disconnected device may still have work waiting to back up.",
  ]);
  summary.addRow([]);
  summary.addRow(["Sponsor", "Confirmed rep scans", "Unique people"]);
  for (const g of report.companies) summary.addRow([g.sponsorCompany, g.scans, g.people]);
  summary.addRow([]);
  const repHeader = summary.addRow(["Sponsor", "Rep ID", "Representative", "Credited scans"]);
  for (const g of report.companies)
    for (const r of g.reps) summary.addRow([g.sponsorCompany, r.id, r.name, r.scans]);
  summary.columns = [{ width: 38 }, { width: 30 }, { width: 32 }, { width: 20 }];
  summary.mergeCells("A3:D3");
  summary.getCell("A3").alignment = { wrapText: true };
  summary.getRow(3).height = 32;
  const style = (row: ExcelJS.Row) => {
    row.eachCell((c) => {
      c.font = { bold: true, color: { argb: "FFFFFFFF" } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF004EB9" } };
    });
  };
  style(summary.getRow(1));
  style(summary.getRow(5));
  style(repHeader);
  const table = (name: string, headers: string[], rows: Record<string, string | number>[]) => {
    const sheet = book.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.columns = headers.map((header) => ({
      header,
      key: header,
      width: /note/i.test(header) ? 55 : /email|time|scanned|UTC|ID/i.test(header) ? 28 : 22,
    }));
    for (const row of rows) sheet.addRow(row);
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
    style(sheet.getRow(1));
  };
  table("Company leads", contactHeaders, contactRows);
  table(
    "Rep scans",
    [
      "Sponsor",
      "Rep ID",
      "Representative",
      "Attendee ID",
      "Name",
      "Job Title",
      "Company",
      "Work Email",
      "First scan (UTC)",
      "Rating",
      "Rep note",
    ],
    report.details,
  );
  return book;
}
