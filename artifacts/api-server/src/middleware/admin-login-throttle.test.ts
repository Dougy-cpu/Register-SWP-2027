import { describe, it, expect, beforeEach } from "vitest";
import type { Request, Response } from "express";
import {
  adminLoginThrottle,
  recordAdminLoginFailure,
  recordAdminLoginSuccess,
  _resetAdminLoginThrottleForTests,
} from "./admin-login-throttle";

function makeReq(ip = "1.2.3.4"): Request {
  return { ip, socket: { remoteAddress: ip } } as unknown as Request;
}

type FakeRes = Response & {
  _status?: number;
  _body?: unknown;
  _headers: Record<string, string>;
};

function makeRes(): FakeRes {
  const res: Record<string, unknown> = { _headers: {} };
  res.setHeader = (k: string, v: string) => {
    (res._headers as Record<string, string>)[k] = v;
    return res;
  };
  res.status = (n: number) => {
    res._status = n;
    return res;
  };
  res.json = (b: unknown) => {
    res._body = b;
    return res;
  };
  return res as unknown as FakeRes;
}

describe("admin login throttle", () => {
  beforeEach(() => {
    _resetAdminLoginThrottleForTests();
  });

  it("does not block before the failure ladder kicks in", () => {
    const req = makeReq();
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      let nextCalled = false;
      adminLoginThrottle(req, res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
      expect(res._status).toBeUndefined();
      recordAdminLoginFailure(req);
    }
  });

  it("locks the IP out after the failure ladder triggers", () => {
    const req = makeReq();
    for (let i = 0; i < 3; i++) recordAdminLoginFailure(req); // first 3 failures: lockedFor 0
    recordAdminLoginFailure(req); // 4th -> 1 minute lock

    const res = makeRes();
    let nextCalled = false;
    adminLoginThrottle(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(429);
    expect(res._headers["Retry-After"]).toBeDefined();
    expect(Number(res._headers["Retry-After"])).toBeGreaterThan(0);
  });

  it("escalates the cool-off with each subsequent failure", () => {
    const req = makeReq();
    for (let i = 0; i < 3; i++) recordAdminLoginFailure(req);
    const fourth = recordAdminLoginFailure(req);
    const fifth = recordAdminLoginFailure(req);
    const sixth = recordAdminLoginFailure(req);
    expect(fifth.lockedForMs).toBeGreaterThan(fourth.lockedForMs);
    expect(sixth.lockedForMs).toBeGreaterThan(fifth.lockedForMs);
  });

  it("resets the failure counter on a successful login", () => {
    const req = makeReq();
    for (let i = 0; i < 5; i++) recordAdminLoginFailure(req);
    recordAdminLoginSuccess(req);

    const res = makeRes();
    let nextCalled = false;
    adminLoginThrottle(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res._status).toBeUndefined();
  });

  it("tracks failures per IP independently", () => {
    const a = makeReq("9.9.9.9");
    const b = makeReq("8.8.8.8");
    for (let i = 0; i < 6; i++) recordAdminLoginFailure(a);

    const res = makeRes();
    let nextCalled = false;
    adminLoginThrottle(b, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res._status).toBeUndefined();
  });
});
