import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import * as schema from "../../../../lib/db/src/schema";

let database: PGlite;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
vi.mock("@workspace/db", async () => ({
  ...(await import("../../../../lib/db/src/schema")),
  db: new Proxy({}, { get: (_, key) => Reflect.get(testDb, key) }),
}));
import {
  cleanOnsiteContact,
  completePreparationTask,
  planPresenterUpdates,
  reopenStaffPreparationTasks,
  saveOnsiteContact,
  saveSessionPresenters,
} from "./sponsor-portal";
import { deriveSponsorTasks } from "./sponsor-progress";
import { saveSessionDraft, sessionSubmissionErrors } from "./sponsor-session-draft";
import { requestAdditionalPasses, resolvePassRequest } from "./sponsor-pass-requests";

beforeAll(async () => {
  database = new PGlite();
  testDb = drizzle(database, { schema });
  await database.exec(`
    CREATE TYPE email_template_type AS ENUM ('welcome','confirmation','invoice_reminder','community_social');
    CREATE TYPE email_log_type AS ENUM ('welcome','confirmation','invoice_reminder','community_social','test');
    CREATE TABLE promo_codes (id SERIAL PRIMARY KEY, code TEXT NOT NULL UNIQUE);
    CREATE TABLE bookings (id SERIAL PRIMARY KEY, manual_entry BOOLEAN NOT NULL DEFAULT FALSE, status TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE attendees (id SERIAL PRIMARY KEY, booking_id INTEGER, community_social_attending BOOLEAN);
    CREATE TABLE notification_emails (id SERIAL PRIMARY KEY);
    CREATE TABLE email_logs (id SERIAL PRIMARY KEY);
  `);
  await database.exec(
    await readFile(
      new URL("../../../../lib/db/migrations/20260901_001_sponsor_workspace.sql", import.meta.url),
      "utf8",
    ),
  );
  await database.exec(`
    INSERT INTO sponsors (id,company,package_label,vip_code_draft,public_code_draft,staff_allocation) VALUES (1,'Sample sponsor','Test','SAMPLEVIP','SAMPLE',4),(2,'Other sponsor','Test','OTHERVIP','OTHER',2);
    INSERT INTO sponsor_sessions (id,sponsor_id,type,entitlement_label) VALUES (11,1,'quickfire','Quickfire'),(12,2,'keynote','Keynote');
    INSERT INTO sponsor_presenters (id,session_id,name,job_title,company) VALUES (21,11,'Alex','Director','Sample sponsor'),(22,12,'Sam','Director','Other sponsor');
    INSERT INTO sponsor_assets (id,sponsor_id,session_id,presenter_id,category,original_name,mime_type,byte_size,checksum_sha256,storage_key,uploader_type)
      VALUES ('headshot',1,11,21,'headshot','speaker.png','image/png',10,'test','not-a-real-storage-object','sponsor');
    INSERT INTO sponsor_contacts (id,sponsor_id,role,first_name,last_name,email,phone,is_primary) VALUES (51,1,'primary','Jamie','Example','jamie@example.invalid','12345',true),(52,2,'primary','Other','Example','other@example.invalid','12345',true);
    INSERT INTO sponsor_tasks (sponsor_id,task_key,label,required) VALUES (1,'staff','Staff',true),(1,'community_social','Social',true),(1,'onsite_contacts','Onsite',true);
    INSERT INTO bookings (id,status,sponsor_id,registration_source) VALUES (31,'paid',1,'sponsor_staff');
    INSERT INTO attendees (id,booking_id,community_social_attending) VALUES (41,31,NULL);
  `);
}, 20_000);
afterAll(async () => {
  await database?.close();
});

describe("Sponsor portal persistence using the real PostgreSQL schema", () => {
  it("quietly saves drafts, preserves headshots, rejects stale writes and rolls back invalid visible submissions", async () => {
    const body = {
      title: "Visible title",
      description: "Visible description",
      takeaways: ["A takeaway"],
      presenters: [{ id: 21, name: "Alex", jobTitle: "Director", company: "Sample sponsor" }],
      expectedRevision: 0,
    };
    const saved = await testDb.transaction((tx) => saveSessionDraft(tx as never, 1, 11, body));
    expect(saved.nextRevision).toBe(1);
    expect(saved.session.status).toBe("draft");
    expect(await sessionSubmissionErrors(11, testDb as never)).toEqual([]);
    expect(
      (await database.query("SELECT presenter_id FROM sponsor_assets WHERE id='headshot'")).rows,
    ).toEqual([{ presenter_id: 21 }]);
    const repeated = await testDb.transaction((tx) => saveSessionDraft(tx as never, 1, 11, body));
    expect(repeated.changed).toBe(false);
    await expect(
      testDb.transaction((tx) =>
        saveSessionDraft(tx as never, 1, 11, { ...body, title: "Stale edit" }),
      ),
    ).rejects.toThrow(/updated elsewhere/);
    await expect(
      testDb.transaction(async (tx) => {
        await saveSessionDraft(tx as never, 1, 11, { ...body, title: "", expectedRevision: 1 });
        const errors = await sessionSubmissionErrors(11, tx as never);
        if (errors.length) throw new Error(errors.join(". "));
      }),
    ).rejects.toThrow(/title/);
    expect(
      (await database.query("SELECT title,current_revision FROM sponsor_sessions WHERE id=11"))
        .rows,
    ).toEqual([{ title: "Visible title", current_revision: 1 }]);
    await database.exec(
      "UPDATE sponsor_sessions SET status='exported',exported_revision=1 WHERE id=11",
    );
    await testDb.transaction((tx) =>
      saveSessionDraft(tx as never, 1, 11, { ...body, title: "New draft", expectedRevision: 1 }),
    );
    expect(
      (
        await database.query(
          "SELECT status,current_revision,exported_revision FROM sponsor_sessions WHERE id=11",
        )
      ).rows,
    ).toEqual([{ status: "draft", current_revision: 2, exported_revision: 1 }]);
  });
  it("records one open request and applies a decision once using the existing database constraint", async () => {
    await database.exec(
      "ALTER TABLE promo_codes ADD COLUMN max_uses INTEGER; ALTER TABLE promo_codes ADD COLUMN updated_at TIMESTAMPTZ; UPDATE sponsors SET status='confirmed' WHERE id=1; INSERT INTO promo_codes (id,code,max_uses) VALUES (71,'SAMPLEVIP',0); INSERT INTO sponsor_promo_codes (sponsor_id,promo_code_id,kind) VALUES (1,71,'vip');",
    );
    const input = { requestedVip: 3, requestedStaff: 2, message: "Please add places" };
    const requests = await Promise.all([
      requestAdditionalPasses(1, input),
      requestAdditionalPasses(1, input),
    ]);
    expect(requests[0].request.id).toBe(requests[1].request.id);
    expect(requests.filter((item) => item.created)).toHaveLength(1);
    await expect(requestAdditionalPasses(1, { ...input, requestedVip: 4 })).rejects.toThrow(
      /earlier request/,
    );
    const decisions = await Promise.all([
      resolvePassRequest(1, requests[0].request.id, "approved"),
      resolvePassRequest(1, requests[0].request.id, "approved"),
    ]);
    expect(decisions.filter((item) => item.changed)).toHaveLength(1);
    expect(
      (await database.query("SELECT vip_allocation,staff_allocation FROM sponsors WHERE id=1"))
        .rows,
    ).toEqual([{ vip_allocation: 3, staff_allocation: 6 }]);
    expect((await database.query("SELECT max_uses FROM promo_codes WHERE id=71")).rows).toEqual([
      { max_uses: 3 },
    ]);
    await expect(resolvePassRequest(2, requests[0].request.id, "approved")).rejects.toThrow(
      /not found/,
    );
    await expect(resolvePassRequest(1, requests[0].request.id, "declined")).rejects.toThrow(
      /different decision/,
    );
    const declined = await requestAdditionalPasses(1, {
      requestedVip: 1,
      requestedStaff: 0,
      message: null,
    });
    await resolvePassRequest(1, declined.request.id, "declined");
    expect((await database.query("SELECT vip_allocation FROM sponsors WHERE id=1")).rows).toEqual([
      { vip_allocation: 3 },
    ]);
  });
  it("updates a presenter in place so their headshot remains linked", async () => {
    await testDb.transaction((tx) =>
      saveSessionPresenters(tx as never, 11, [
        {
          id: 21,
          name: "Alex Updated",
          jobTitle: "Director",
          company: "Sample sponsor",
          biography: null,
          displayOrder: 0,
        },
      ]),
    );
    expect(
      (await database.query("SELECT presenter_id FROM sponsor_assets WHERE id='headshot'")).rows,
    ).toEqual([{ presenter_id: 21 }]);
    expect((await database.query("SELECT name FROM sponsor_presenters WHERE id=21")).rows).toEqual([
      { name: "Alex Updated" },
    ]);
  });
  it("rejects a presenter belonging to another sponsor's session", async () => {
    await expect(
      testDb.transaction((tx) =>
        saveSessionPresenters(tx as never, 11, [
          {
            id: 22,
            name: "Wrong",
            jobTitle: "Director",
            company: "Other",
            biography: null,
            displayOrder: 0,
          },
        ]),
      ),
    ).rejects.toThrow(/speaker has changed/);
    expect((await database.query("SELECT name FROM sponsor_presenters WHERE id=22")).rows).toEqual([
      { name: "Sam" },
    ]);
  });
  it("blocks removal of a presenter with active files", async () => {
    await expect(
      testDb.transaction((tx) => saveSessionPresenters(tx as never, 11, [])),
    ).rejects.toThrow(/uploaded files/);
    expect(
      (await database.query("SELECT presenter_id FROM sponsor_assets WHERE id='headshot'")).rows,
    ).toEqual([{ presenter_id: 21 }]);
  });
  it("preserves primary contact status and prevents duplicate contacts", async () => {
    const input = {
      id: 51,
      firstName: "Jamie",
      lastName: "Example",
      email: " JAMIE@EXAMPLE.INVALID ",
      phone: "12345",
    };
    const saved = await saveOnsiteContact(1, input);
    expect(saved).toMatchObject({
      id: 51,
      isPrimary: true,
      role: "onsite",
      email: "jamie@example.invalid",
    });
    const again = await saveOnsiteContact(1, { ...input, id: undefined });
    expect(again.id).toBe(51);
    expect(
      (
        await database.query(
          "SELECT count(*)::int AS count FROM sponsor_contacts WHERE sponsor_id=1",
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
  it("does not allow editing another sponsor's contact", async () => {
    await expect(
      saveOnsiteContact(1, {
        id: 52,
        firstName: "Other",
        lastName: "Example",
        email: "other@example.invalid",
        phone: "12345",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("confirms a partly used staff allocation idempotently", async () => {
    const results = await Promise.all([
      completePreparationTask(1, "staff"),
      completePreparationTask(1, "staff"),
    ]);
    expect(results.filter((result) => result.changed)).toHaveLength(1);
    expect(results.every((result) => result.task.status === "completed")).toBe(true);
    expect(
      (
        await database.query(
          "SELECT count(*)::int AS count FROM sponsor_activity WHERE type='staff_confirmed'",
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
  it("requires all active staff Social choices, allows nobody attending, then reopens after changes", async () => {
    await expect(completePreparationTask(1, "community_social")).rejects.toThrow(
      /each team member/,
    );
    await database.exec("UPDATE attendees SET community_social_attending=false WHERE id=41");
    expect((await completePreparationTask(1, "community_social")).task.status).toBe("completed");
    await testDb.transaction((tx) => reopenStaffPreparationTasks(tx as never, 1));
    expect(
      (
        await database.query(
          "SELECT status FROM sponsor_tasks WHERE task_key IN ('staff','community_social')",
        )
      ).rows,
    ).toEqual([{ status: "todo" }, { status: "todo" }]);
  });
  it("validates contact fields and safely maps older clients' speaker positions", () => {
    expect(() =>
      cleanOnsiteContact({ firstName: "Name", lastName: "Example", email: "bad", phone: "1" }),
    ).toThrow(/valid email/);
    const person = {
      name: "Alex",
      jobTitle: "Director",
      company: "Example",
      biography: null,
      displayOrder: 0,
    };
    expect(planPresenterUpdates([{ id: 21 }], [person]).values[0].id).toBe(21);
    expect(() =>
      planPresenterUpdates(
        [{ id: 21 }],
        [
          { ...person, id: 21 },
          { ...person, id: 21 },
        ],
      ),
    ).toThrow();
  });
});

describe("Accurate preparation progress", () => {
  const tasks = ["sessions", "speakers", "assets", "slides", "logistics", "staff"].map(
    (taskKey) => ({
      taskKey,
      required: true,
      status: "submitted" as const,
      dueAt: new Date("2020-01-01"),
      completedAt: null,
    }),
  );
  it("does not complete all sessions when just one is approved, or all slides after one upload", () => {
    const result = deriveSponsorTasks(tasks, {
      sessions: [
        { id: 11, status: "approved", slidesRequired: true },
        { id: 12, status: "draft", slidesRequired: true },
      ],
      assets: [{ id: "slides1", category: "slides", status: "active", sessionId: 11 }],
      contacts: [],
      documents: [],
    });
    expect(result.find((task) => task.taskKey === "sessions")?.status).toBe("overdue");
    expect(result.find((task) => task.taskKey === "slides")?.status).toBe("overdue");
    expect(result.find((task) => task.taskKey === "logistics")?.status).toBe("submitted");
  });
  it("uses active files and current document acknowledgement, preserving explicit staff confirmation", () => {
    const result = deriveSponsorTasks(tasks, {
      sessions: [{ id: 11, status: "approved", slidesRequired: true }],
      assets: [
        { id: "logo", category: "logo", status: "active", sessionId: null },
        { id: "slides", category: "slides", status: "missing", sessionId: 11 },
        { id: "guide", category: "logistics", status: "active", sessionId: null },
      ],
      contacts: [],
      documents: [{ assetId: "guide", required: true, acknowledged: false }],
    });
    expect(result.find((task) => task.taskKey === "assets")?.status).toBe("completed");
    expect(result.find((task) => task.taskKey === "sessions")?.status).toBe("completed");
    expect(result.find((task) => task.taskKey === "slides")?.status).toBe("overdue");
    expect(result.find((task) => task.taskKey === "logistics")?.status).toBe("overdue");
    expect(result.find((task) => task.taskKey === "staff")?.status).toBe("submitted");
  });
});
