import { afterEach, expect, it } from "vitest";
import {
  REHEARSAL_STORAGE_KEY,
  readRehearsal,
  saveRehearsal,
  type RehearsalLead,
} from "./scanner-rehearsal";

afterEach(() => localStorage.removeItem(REHEARSAL_STORAGE_KEY));
const lead: RehearsalLead = {
  code: "FACADE000001",
  source: "camera",
  capturedAt: "2026-09-10T12:00:00.000Z",
  note: "",
  rating: null,
};

it.each([
  { leads: [{ ...lead, code: "ABCDEF123456" }] },
  { leads: [lead, lead] },
  { leads: [{ ...lead, rating: 6 }] },
  { leads: [{ ...lead, note: "x".repeat(4001) }] },
  { leads: [{ ...lead, capturedAt: "not a timestamp" }] },
])("rejects malformed or non-practice persisted records", ({ leads }) => {
  localStorage.setItem(REHEARSAL_STORAGE_KEY, JSON.stringify({ format: 1, leads }));
  expect(() => readRehearsal()).toThrow();
});

it("keeps the previous saved practice data when a proposed record is invalid", () => {
  saveRehearsal([lead]);
  expect(() => saveRehearsal([{ ...lead, code: "ABCDEF123456" }])).toThrow();
  expect(readRehearsal()).toEqual([lead]);
});
