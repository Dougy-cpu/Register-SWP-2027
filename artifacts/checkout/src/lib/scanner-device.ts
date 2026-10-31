// Include iPadOS desktop mode without turning ordinary desktop visits into scanners.
export function isScannerPhone(
  userAgent = navigator.userAgent,
  touchPoints = navigator.maxTouchPoints ?? 0,
): boolean {
  return (
    /iPhone|iPod|iPad|Android/i.test(userAgent) || (/Macintosh/i.test(userAgent) && touchPoints > 1)
  );
}
