export type ScanSource = "camera" | "image" | "manual";

export interface ScannerCredential {
  id: string;
  token: string;
  operatorName: string;
  sponsorId: number;
  sponsorCompany: string;
  activatedAt: string;
}

export interface ScannerWindow {
  eventStartAt: string | null;
  eventEndAt: string | null;
  scanClosesAt: string | null;
  scanningOpen: boolean;
}

export interface ScannerDeviceState {
  id: string;
  operatorName: string;
  sponsorId: number;
  sponsorCompany: string;
  packVersion: string | null;
  currentPackVersion: string;
  cameraTested: boolean;
  qrTested: boolean;
  storageTested: boolean;
  offlineTested: boolean;
  syncTested: boolean;
  ready: boolean;
  outOfDate: boolean;
  lastSyncedAt: string | null;
}

export interface ScannerBootstrap {
  device: ScannerDeviceState;
  scannerWindow: ScannerWindow;
  testQrValue: string;
}

export interface EncryptedLeadRecord {
  lookup: string;
  badgeVersion: number;
  iv: string;
  ciphertext: string;
}

export interface ScannerOfflinePackDownload {
  format: number;
  version: string;
  generatedAt: string;
  refreshAfter: string;
  expiresAt: string | null;
  keyContext: string;
  records: EncryptedLeadRecord[];
}

export interface LeadPackAttendee {
  attendeeId: number;
  name: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  company: string;
  workEmail: string;
}

export interface StoredOfflinePack extends ScannerOfflinePackDownload {
  key: "current";
}

export interface PendingScan {
  id: string;
  code: string;
  source: ScanSource;
  capturedAt: string;
  attendee: LeadPackAttendee;
}

export interface PendingAnnotation {
  id: string;
  scanId: string;
  note: string | null;
  rating: number | null;
  createdAt: string;
}

export interface RejectedSyncItem {
  id: string;
  kind: "scan" | "annotation";
  reason: string;
  rejectedAt: string;
  payload: PendingScan | PendingAnnotation;
}

export interface SponsorLeadScan {
  id: string;
  operatorName: string;
  source: ScanSource;
  capturedAt: string;
}

export interface SponsorLeadNote {
  id: string;
  operatorName: string;
  note: string | null;
  rating: number | null;
  createdAt: string;
}

export interface SponsorLead {
  id: string;
  sponsorId: number;
  sponsorCompany: string;
  attendeeId: number;
  firstName: string;
  lastName: string;
  name: string;
  jobTitle: string;
  company: string;
  workEmail: string;
  rating: number | null;
  scanCount: number;
  firstScannedAt: string | null;
  lastScannedAt: string | null;
  scans: SponsorLeadScan[];
  notes: SponsorLeadNote[];
}

export interface LeadScannerAdminDevice {
  id: string;
  sponsorId: number;
  sponsorCompany: string;
  operatorName: string;
  status: "ready" | "out_of_date" | "not_tested" | "revoked";
  packVersion: string | null;
  activatedAt: string;
  lastSeenAt: string;
  lastSyncedAt: string | null;
  revokedAt: string | null;
}

export interface LeadScannerAdminOverview {
  leadCount: number;
  deviceCount: number;
  badgeCount: number;
  currentPackVersion: string;
  testQrValue: string;
  scannerWindow: ScannerWindow;
  devices: LeadScannerAdminDevice[];
}

export interface LeadScannerAttendee {
  attendeeId: number;
  firstName: string;
  lastName: string;
  name: string;
  jobTitle: string;
  company: string;
  workEmail: string;
  isTbc: boolean;
  bookingStatus: string;
  leadSharingExcluded: boolean;
  leadSharingNoticeAt: string | null;
  badgeVersion: number | null;
  badgeActive: boolean;
}
