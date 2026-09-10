import { expect, it } from "vitest";
import { isScannerPhone } from "./scanner-device";

it.each([
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) Mobile/15E148 Safari/604.1", true],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148", true],
  ["Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/128.0.0.0 Mobile Safari/537.36", true],
  ["Mozilla/5.0 (Linux; Android 10; SM-A205F) Chrome/128.0.0.0 Mobile Safari/537.36", true],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0 Safari/537.36", false],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605.1.15", false],
  ["Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Mobile/15E148", false],
])("keeps phone scanning separate from desktop and tablet: %s", (agent, expected) => {
  expect(isScannerPhone(agent as string)).toBe(expected);
});
