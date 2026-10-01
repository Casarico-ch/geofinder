// =============================================================================
// Popety.io client — Swiss real-estate data (lands, buildings, zoning, …).
// Spec: https://api.popety.io/openapi.json. Needs POPETY_API_KEY in the env.
// =============================================================================
const BASE_URL = process.env.POPETY_BASE_URL ?? "https://api.popety.io";

export async function popety<T = unknown>(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  const key = process.env.POPETY_API_KEY;
  if (!key) throw new Error("POPETY_API_KEY is not set");
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      Authorization: `Bearer ${key}`,
      "X-Popety-Locale": "fr-CH",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Popety ${res.status} on ${path}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

export const findLandByAddress = (address: string) =>
  popety<{ popetyio_land_id: string; matched_address: string }>(
    `/v1/lands/find-by-address/${encodeURIComponent(address)}`,
  );

export const getLand = (id: string) => popety(`/v1/lands/${encodeURIComponent(id)}`);
