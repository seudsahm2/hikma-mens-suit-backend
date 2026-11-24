/** Addis Ababa is UTC+3 all year (no daylight saving). */
export const ADDIS_OFFSET_MS = 3 * 3600_000;

/** Midnight in Addis Ababa (as a UTC Date) for the day containing `d`. */
export function startOfAddisDay(d = new Date()) {
  const local = new Date(d.getTime() + ADDIS_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - ADDIS_OFFSET_MS);
}

/** "YYYY-MM-DD" in Addis Ababa. */
export function addisDate(d = new Date()) {
  return new Date(d.getTime() + ADDIS_OFFSET_MS).toISOString().slice(0, 10);
}

/** Hour of the day (0–23) in Addis Ababa. */
export function addisHour(d = new Date()) {
  return new Date(d.getTime() + ADDIS_OFFSET_MS).getUTCHours();
}
