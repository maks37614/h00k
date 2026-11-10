let currentUid: string | null = null;
export function setApiAccount(uid: string | null) {
  currentUid = uid;
}

/** Same-origin HttpOnly sessions; an account switch invalidates in-flight writes. */
export async function apiFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  if (!url.startsWith("/api/") || url.startsWith("//"))
    throw new Error("Неприпустима адреса запиту");
  const owner = currentUid;
  const queryOwner = new URL(url, "https://h00k.top").searchParams.get(
    "userId",
  );
  let bodyOwner: string | undefined;
  if (typeof options.body === "string") {
    try {
      bodyOwner = JSON.parse(options.body)?.userId;
    } catch {}
  }
  if (
    owner &&
    [queryOwner, bodyOwner].some((value) => value && value !== owner)
  )
    throw new Error("Акаунт змінився. Повторіть дію.");
  const headers = new Headers(options.headers);
  headers.set("X-H00K-Request", "1");
  const response = await fetch(url, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  if (owner !== currentUid) throw new Error("Акаунт змінився. Повторіть дію.");
  return response;
}
export async function apiJson<T = any>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const owner = currentUid;
  const headers = new Headers(options.headers);
  if (typeof options.body === "string")
    headers.set("Content-Type", "application/json");
  const response = await apiFetch(url, { ...options, headers });
  const data = await response.json();
  if (owner !== currentUid) throw new Error("Акаунт змінився. Повторіть дію.");
  if (!response.ok || data.success === false)
    throw new Error(data.error || "Не вдалося виконати запит");
  return data;
}
