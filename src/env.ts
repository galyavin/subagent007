export function safeIntegerFromEnv(key: string, fallback: number, minValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minValue) {
    return fallback;
  }
  return parsed;
}
