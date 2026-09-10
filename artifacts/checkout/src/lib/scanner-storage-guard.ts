export const STORAGE_TIMEOUT_MS = 8000;

export class ScannerStorageError extends Error {
  constructor() {
    super(
      "Phone storage is not responding. This badge is not confirmed saved. Keep this page open and try again.",
    );
    this.name = "ScannerStorageError";
  }
}

export function storageOperation<T>(operation: Promise<T>, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new ScannerStorageError());
    }, STORAGE_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Abort slow writes as well as releasing their callers. Stable capture receipts
// let a retry recognise a commit if the browser delivered its acknowledgement late.
export function startStorageTransaction<T extends { done: Promise<unknown>; abort(): void }>(
  tx: T,
): T {
  const timer = setTimeout(() => {
    try {
      tx.abort();
    } catch {
      /* A completed transaction cannot be aborted. */
    }
  }, STORAGE_TIMEOUT_MS - 100);
  void tx.done.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  );
  return tx;
}
