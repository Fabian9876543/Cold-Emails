import { notifications } from "@mantine/notifications";
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body !== undefined && !isForm ? { "Content-Type": "application/json" } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith("/api/login")) {
      window.dispatchEvent(new Event("ce:unauthorized"));
    }
    const message = (isJson && data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : null) ?? `Fehler ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body ?? {}),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body ?? {}),
  del: <T>(url: string) => request<T>("DELETE", url),
  upload: <T>(url: string, form: FormData) => request<T>("POST", url, form),
};

/** Lädt Daten per GET; der Abfrageschlüssel ist die URL. */
export function useApi<T>(url: string | null, options?: Omit<UseQueryOptions<T>, "queryKey" | "queryFn">) {
  return useQuery<T>({
    queryKey: [url],
    queryFn: () => api.get<T>(url as string),
    enabled: url !== null && (options?.enabled ?? true),
    ...options,
  });
}

export function notifyError(err: unknown, title = "Das hat nicht geklappt") {
  const message = err instanceof Error ? err.message : String(err);
  notifications.show({ color: "red", title, message, autoClose: 8000 });
}

export function notifySuccess(message: string, title?: string) {
  notifications.show({ color: "teal", title, message, autoClose: 4000 });
}
