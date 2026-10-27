// Model tool inputs and query strings arrive as `unknown`. A string stays as it
// is and a number or boolean is printed; an object (a model that answers with
// a structure where a string was asked) becomes JSON instead of "[object Object]".
export function asText(v: unknown, fallback = ""): string {
  if (v == null) return fallback;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return JSON.stringify(v) ?? fallback;
}
