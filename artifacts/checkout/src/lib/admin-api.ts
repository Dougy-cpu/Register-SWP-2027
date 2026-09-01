export async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem("admin_token") ?? "";
  const isForm = init.body instanceof FormData;
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(isForm ? {} : { "Content-Type": "application/json" }),
      "x-admin-token": token,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (response.status === 401) window.dispatchEvent(new Event("api:unauthorized"));
  return response;
}

export async function adminJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await adminFetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "The request could not be completed");
  return body as T;
}

export async function downloadAdminFile(
  path: string,
  filename: string,
  init?: RequestInit,
): Promise<void> {
  const response = await adminFetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "The download could not be created");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
