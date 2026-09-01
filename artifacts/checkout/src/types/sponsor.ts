export type SponsorStatus = "draft" | "confirmed" | "paused" | "completed" | "cancelled";
export type SponsorAssetCategory =
  | "logo"
  | "headshot"
  | "slides"
  | "session_material"
  | "logistics"
  | "other";

export interface SponsorSummary {
  id: number;
  company: string;
  packageLabel: string;
  status: SponsorStatus;
  confirmationDate: string | null;
  vipAllocation: number;
  vipUsed: number;
  staffAllocation: number;
  staffUsed: number;
  progressCompleted: number;
  progressTotal: number;
  needsAttention: number;
  updatedAt: string;
}

export interface SponsorContact {
  id?: number;
  role: "primary" | "onsite" | "marketing" | "other";
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  email: string;
  phone: string | null;
  isPrimary: boolean;
}

export interface SponsorTask {
  id: number;
  taskKey: string;
  label: string;
  required: boolean;
  dueAt: string | null;
  status: "todo" | "submitted" | "completed" | "overdue" | "not_required";
  completedAt: string | null;
}

export interface SponsorRedemption {
  bookingId: number;
  firstName: string;
  lastName: string;
  company: string;
  jobTitle: string;
  registeredAt: string;
}

export interface SponsorCode {
  kind: "vip" | "public";
  code: string;
  active: boolean;
  workforceUrl: string;
  allocation: number | null;
  used: number;
  remaining: number | null;
  maxPerBooking: number | null;
  discountPercent: number | null;
  redemptions: SponsorRedemption[];
}

export interface SponsorStaff {
  bookingId: number;
  attendeeId: number;
  firstName: string;
  lastName: string;
  jobTitle: string;
  company: string;
  workEmail: string;
  phone: string | null;
  dietaryAccessibility: string | null;
  communitySocialAttending: boolean | null;
  communitySocialDietary: string | null;
  marketingConsent: boolean;
  status: string;
  registeredAt: string;
}

export interface SponsorPresenter {
  id?: number;
  name: string;
  jobTitle: string;
  company: string;
  biography?: string | null;
  displayOrder?: number;
}

export interface SponsorSession {
  id: number;
  type: "quickfire" | "keynote" | "other";
  entitlementLabel: string;
  title: string | null;
  description: string | null;
  takeaways: string[];
  status: "draft" | "submitted" | "changes_requested" | "approved" | "exported";
  feedback: string | null;
  headshotRequired: boolean;
  takeawaysRequired: boolean;
  slidesRequired: boolean;
  currentRevision: number;
  exportedRevision: number | null;
  exportOutdated: boolean;
  presenters: SponsorPresenter[];
  revisions: Array<{ revision: number; actor: string; createdAt: string }>;
}

export interface SponsorAsset {
  id: string;
  sponsorId: number;
  sponsorCompany?: string | null;
  sessionId: number | null;
  presenterId: number | null;
  category: SponsorAssetCategory;
  originalName: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
  version: number;
  status: "active" | "archived" | "missing";
  uploaderType: string;
  uploaderLabel: string | null;
  createdAt: string;
  previewAvailable: boolean;
}

export interface SponsorDocument {
  id: number;
  assetId: string;
  title: string;
  required: boolean;
  acknowledgementVersion: number;
  acknowledged: boolean;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
}

export interface SponsorWorkspace extends SponsorSummary {
  sponsor: SponsorSummary;
  notes?: string | null;
  vipCodeDraft?: string;
  publicCodeDraft?: string;
  accessUrl?: string | null;
  welcomeEmailSentAt?: string | null;
  contacts: SponsorContact[];
  codes: SponsorCode[];
  staff: SponsorStaff[];
  tasks: SponsorTask[];
  sessions: SponsorSession[];
  assets: SponsorAsset[];
  documents: SponsorDocument[];
  invitationCopy: { vip: string; public: string };
  activity?: Array<{
    id: number;
    type: string;
    actorType: string;
    actorLabel: string | null;
    data: Record<string, unknown>;
    createdAt: string;
  }>;
}
