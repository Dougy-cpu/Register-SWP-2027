// A phone-only product gate, not a security boundary. Do not use viewport width:
// rotating an iPhone must not unmount an active scan or a note being edited.
export function isScannerPhone(userAgent = navigator.userAgent): boolean {
  return /iPhone|iPod|Android.*Mobile/i.test(userAgent);
}
