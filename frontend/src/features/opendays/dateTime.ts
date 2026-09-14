function wallParts(instant: Date, timeZone: string) {
  const values: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-CA-u-ca-gregory', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return values;
}

export function dateInTimeZone(instant: string, timeZone: string) {
  const parts = wallParts(new Date(instant), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function timeInTimeZone(instant: string, timeZone: string) {
  const parts = wallParts(new Date(instant), timeZone);
  return `${parts.hour}:${parts.minute}`;
}

export function zonedDateTimeToISO(date: string, clock: string, timeZone: string) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = clock.split(':').map(Number);
  const wallTimestamp = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = wallTimestamp;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = wallParts(new Date(candidate), timeZone);
    const representedWallTime = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const correction = wallTimestamp - representedWallTime;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate).toISOString();
}
