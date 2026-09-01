import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const authState = vi.hoisted(() => ({
  sponsor: { accessVersion: 1, status: "confirmed" } as {
    accessVersion: number;
    status: string;
  } | null,
}));

vi.mock("@workspace/db", () => ({
  sponsorsTable: { portalAccessVersion: {}, status: {}, id: {} },
  db: {
    select: () => ({
      from: () => ({
        where: async () => (authState.sponsor ? [authState.sponsor] : []),
      }),
    }),
  },
}));

vi.mock("../lib/env", () => ({ isProductionEnv: () => false }));
vi.mock("../lib/logger", () => ({ logger: { warn: vi.fn() } }));

import {
  _resetSponsorSecretForTests,
  issueSponsorAccessToken,
  setSponsorSessionCookie,
  sponsorAuth,
  verifySponsorAccessToken,
} from "./sponsor-auth";

function responseDouble() {
  const cookies = new Map<string, string>();
  const response = {
    statusCode: 200,
    cookie: vi.fn((name: string, value: string) => {
      cookies.set(name, value);
      return response;
    }),
    clearCookie: vi.fn(() => response),
    status: vi.fn((code: number) => {
      response.statusCode = code;
      return response;
    }),
    json: vi.fn(() => response),
  };
  return { response: response as unknown as Response, cookies, raw: response };
}

function requestWithSession(
  cookies: Map<string, string>,
  method: string,
  csrfHeader?: string,
): Request {
  const cookieHeader = [...cookies.entries()]
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
  return {
    method,
    headers: {
      cookie: cookieHeader,
      ...(csrfHeader ? { "x-sponsor-csrf": csrfHeader } : {}),
    },
  } as unknown as Request;
}

beforeEach(() => {
  process.env.SPONSOR_TOKEN_SECRET = "sponsor-test-secret-that-is-longer-than-32-characters";
  authState.sponsor = { accessVersion: 1, status: "confirmed" };
  _resetSponsorSecretForTests();
});

describe("sponsor signed access", () => {
  it("verifies an issued private-link token and rejects tampering", () => {
    const token = issueSponsorAccessToken(42, 3);
    expect(verifySponsorAccessToken(token)).toEqual({ sponsorId: 42, accessVersion: 3 });
    expect(verifySponsorAccessToken(token.replace("42.3", "42.4"))).toBeNull();
  });

  it("accepts a valid cookie session and matching CSRF token", async () => {
    const issued = responseDouble();
    setSponsorSessionCookie(issued.response, 42, 1);
    const csrf = issued.cookies.get("swp_sponsor_csrf");
    const next = vi.fn() as unknown as NextFunction;
    const checked = responseDouble();

    await sponsorAuth(requestWithSession(issued.cookies, "POST", csrf), checked.response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(checked.raw.status).not.toHaveBeenCalled();
  });

  it("blocks a state-changing request without matching CSRF", async () => {
    const issued = responseDouble();
    setSponsorSessionCookie(issued.response, 42, 1);
    const next = vi.fn() as unknown as NextFunction;
    const checked = responseDouble();

    await sponsorAuth(
      requestWithSession(issued.cookies, "PATCH", "wrong-token"),
      checked.response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(checked.raw.statusCode).toBe(403);
  });

  it("revokes an existing session after access rotation", async () => {
    const issued = responseDouble();
    setSponsorSessionCookie(issued.response, 42, 1);
    authState.sponsor = { accessVersion: 2, status: "confirmed" };
    const next = vi.fn() as unknown as NextFunction;
    const checked = responseDouble();

    await sponsorAuth(requestWithSession(issued.cookies, "GET"), checked.response, next);

    expect(next).not.toHaveBeenCalled();
    expect(checked.raw.statusCode).toBe(401);
    expect(checked.raw.clearCookie).toHaveBeenCalled();
  });
});
