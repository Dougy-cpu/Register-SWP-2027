import type { SponsorAsset, SponsorSession, SponsorStaff, SponsorWorkspace } from "@/types/sponsor";

export function makeSession(overrides: Partial<SponsorSession> = {}): SponsorSession {
  return {
    id: 11,
    type: "quickfire",
    entitlementLabel: "Morning Quickfire",
    title: "Workforce decisions that matter",
    description: "A practical look at how leaders turn workforce plans into decisions.",
    takeaways: ["Choose the decisions that matter"],
    status: "draft",
    feedback: null,
    headshotRequired: false,
    takeawaysRequired: true,
    slidesRequired: true,
    currentRevision: 1,
    exportedRevision: null,
    exportOutdated: false,
    presenters: [
      {
        id: 21,
        name: "Alex Example",
        jobTitle: "Workforce Planning Director",
        company: "Example Partners",
        biography: "",
      },
    ],
    revisions: [],
    ...overrides,
  };
}
export function makeStaff(overrides: Partial<SponsorStaff> = {}): SponsorStaff {
  return {
    bookingId: 31,
    attendeeId: 41,
    firstName: "Alex",
    lastName: "Example",
    jobTitle: "Workforce Planning Director",
    company: "Example Partners",
    workEmail: "alex@example.invalid",
    phone: null,
    dietaryAccessibility: null,
    communitySocialAttending: null,
    communitySocialDietary: null,
    marketingConsent: false,
    status: "paid",
    registeredAt: "2026-09-04T09:00:00Z",
    ...overrides,
  };
}
export function makeAsset(overrides: Partial<SponsorAsset> = {}): SponsorAsset {
  return {
    id: "fixture-photo",
    sponsorId: 1,
    sessionId: 11,
    presenterId: 21,
    category: "headshot",
    originalName: "speaker.jpg",
    mimeType: "image/jpeg",
    byteSize: 100,
    checksumSha256: "test-only",
    version: 1,
    status: "active",
    uploaderType: "sponsor",
    uploaderLabel: null,
    createdAt: "2026-09-04T09:00:00Z",
    previewAvailable: true,
    ...overrides,
  };
}
export function createPortalFixture(): SponsorWorkspace {
  const sponsor = {
    id: 1,
    company: "Example Partners",
    packageLabel: "Summit Partner",
    status: "confirmed" as const,
    confirmationDate: "2026-09-04",
    vipAllocation: 10,
    vipUsed: 2,
    staffAllocation: 4,
    staffUsed: 1,
    progressCompleted: 0,
    progressTotal: 8,
    needsAttention: 0,
    updatedAt: "2026-09-04T09:00:00Z",
  };
  return {
    ...sponsor,
    sponsor,
    contacts: [
      {
        id: 51,
        role: "primary",
        firstName: "Jamie",
        lastName: "Example",
        jobTitle: "Marketing Director",
        email: "jamie@example.invalid",
        phone: "+44 0000 000000",
        isPrimary: true,
      },
    ],
    staff: [makeStaff()],
    sessions: [
      makeSession(),
      makeSession({
        id: 12,
        type: "keynote",
        entitlementLabel: "Main-stage speaking slot",
        title: "",
        description: "",
        takeaways: [],
        currentRevision: 0,
        presenters: [],
        headshotRequired: true,
      }),
    ],
    assets: [],
    documents: [],
    tasks: [
      "staff",
      "sessions",
      "speakers",
      "assets",
      "logistics",
      "onsite_contacts",
      "slides",
      "community_social",
    ].map((taskKey, index) => ({
      id: index + 1,
      taskKey,
      label: taskKey,
      required: true,
      dueAt: ["sessions", "speakers", "assets"].includes(taskKey)
        ? "2027-01-15T12:00:00Z"
        : taskKey === "slides"
          ? "2027-02-19T12:00:00Z"
          : null,
      status: "todo",
      completedAt: null,
    })),
    codes: [
      {
        kind: "vip",
        code: "EXAMPLEVIP",
        active: true,
        workforceUrl: "/?pass=single&promo=EXAMPLEVIP",
        allocation: 10,
        used: 2,
        remaining: 8,
        maxPerBooking: 1,
        discountPercent: null,
        redemptions: [],
      },
      {
        kind: "public",
        code: "EXAMPLE",
        active: true,
        workforceUrl: "/?pass=single&promo=EXAMPLE",
        allocation: null,
        used: 0,
        remaining: null,
        maxPerBooking: null,
        discountPercent: 20,
        redemptions: [],
      },
    ],
    invitationCopy: {
      vip: "Join us at SWP Summit 2027 with a complimentary Workforce Pass. Your private invitation: example.invalid/vip",
      public:
        "Join us at SWP Summit 2027. Use EXAMPLE for 20% off Workforce Passes at example.invalid/register.",
    },
  };
}
