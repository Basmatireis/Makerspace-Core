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
  const offsets = new Set<number>();
  for (const hours of [-48, -24, 0, 24, 48]) {
    const sample = wallTimestamp + hours * 3600000;
    const parts = wallParts(new Date(sample), timeZone);
    offsets.add(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - sample);
  }
  const candidates = [...offsets].map((offset) => wallTimestamp - offset).filter((instant) => {
    const parts = wallParts(new Date(instant), timeZone);
    return `${parts.year}-${parts.month}-${parts.day}` === date && `${parts.hour}:${parts.minute}` === clock;
  });
  if (candidates.length !== 1) {
    const reason = candidates.length > 1 ? 'is ambiguous' : 'does not exist';
    throw new Error(`Local time ${date} ${clock} ${reason} in ${timeZone}. Choose a different time.`);
  }
  return new Date(candidates[0]).toISOString();
}

export function nextCalendarDate(date: string) {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function validateLocalInstant(instant: string, timeZone: string) {
  zonedDateTimeToISO(dateInTimeZone(instant, timeZone), timeInTimeZone(instant, timeZone), timeZone);
}
