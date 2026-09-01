function csrfCookie(): string {
  const match = document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("swp_sponsor_csrf="));
  return match ? decodeURIComponent(match.slice(match.indexOf("=") + 1)) : "";
}

export async function sponsorFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const isForm = init.body instanceof FormData;
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      ...(isForm ? {} : { "Content-Type": "application/json" }),
      ...(!["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase())
        ? { "x-sponsor-csrf": csrfCookie() }
        : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  return response;
}

export async function sponsorJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await sponsorFetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "The request could not be completed");
  return body as T;
}
