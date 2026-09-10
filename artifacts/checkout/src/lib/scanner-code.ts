export const BADGE_CODE_LENGTH = 12;
export const BADGE_CODE_PATTERN = /^[0-9A-F]{12}$/;

export function normaliseBadgeCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return BADGE_CODE_PATTERN.test(code) ? code : null;
}
