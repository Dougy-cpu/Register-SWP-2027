import { useEffect } from "react";

export function useScannerAwake(scanning: boolean) {
  useEffect(() => {
    if (!scanning || !navigator.wakeLock?.request) return;
    let active = true;
    let lock: WakeLockSentinel | undefined;
    void navigator.wakeLock
      .request("screen")
      .then((value) => {
        if (active) lock = value;
        else void value.release().catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      void lock?.release().catch(() => undefined);
    };
  }, [scanning]);
}
