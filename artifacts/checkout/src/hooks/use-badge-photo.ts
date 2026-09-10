import { useCallback, useEffect, useRef, useState } from "react";
import QrScanner from "qr-scanner";

export const PHOTO_TIMEOUT_MS = 10_000;
export function useBadgePhoto(
  onDecode: (value: string) => void | Promise<void>,
  onError: (message: string) => void,
) {
  const epoch = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const cancel = useCallback(() => {
    epoch.current++;
    clearTimeout(timer.current);
    setBusy(false);
  }, []);
  useEffect(
    () => () => {
      epoch.current++;
      clearTimeout(timer.current);
    },
    [],
  );
  const scan = async (file?: File) => {
    if (!file) return;
    cancel();
    const id = epoch.current;
    setBusy(true);
    timer.current = setTimeout(() => {
      if (id !== epoch.current) return;
      cancel();
      onError("The photo took too long to read. Try a smaller, clearer photo or use the camera.");
    }, PHOTO_TIMEOUT_MS);
    try {
      const result = await QrScanner.scanImage(file, {
        returnDetailedScanResult: true,
        alsoTryWithoutScanRegion: true,
      });
      if (id === epoch.current) {
        // Decoding is complete. Keep controls busy while the caller persists the
        // badge and reports any persistence error. Do not mislabel a later save
        // as an image-decoding timeout.
        clearTimeout(timer.current);
        await onDecode(result.data);
      }
    } catch {
      if (id === epoch.current)
        onError(
          "No readable badge QR was found in that photograph. Try again with the whole QR in view.",
        );
    } finally {
      if (id === epoch.current) {
        clearTimeout(timer.current);
        setBusy(false);
      }
    }
  };
  return { scan, cancel, busy };
}
