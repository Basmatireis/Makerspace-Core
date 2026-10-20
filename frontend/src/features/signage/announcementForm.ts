import type { SignageTemplateField } from '../../api/generated/models';
import { errorMessage } from './helpers';

const pad = (value: number) => String(value).padStart(2, '0');

/** `YYYY-MM-DDTHH:MM` in the browser's zone. */
export const toLocalValue = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
/** The instant for a `YYYY-MM-DDTHH:MM` reading in the browser's zone; null while date or time is missing. */
export function fromLocalValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  return Number.isNaN(date.getTime()) ? null : date;
}
export const nextHour = (from: Date, hours: number) => {
  const date = new Date(from);
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + hours);
  return toLocalValue(date);
};
export const defaultsOf = (fields: readonly SignageTemplateField[]) =>
  Object.fromEntries(fields.map((field) => [field.key, field.defaultValue]));

export type ServerErrors = {
  fields: Record<string, string>;
  displays?: string;
  start?: string;
  end?: string;
  general?: string;
};

/** Maps the backend's 422 messages to the control they are about; anything unrecognised stays a general message. */
export function mapAnnouncementError(error: unknown, fields: readonly SignageTemplateField[]): ServerErrors {
  const message = errorMessage(error);
  const result: ServerErrors = { fields: {} };
  const byLabel = fields.find((field) => message.startsWith(`${field.label} `));
  if (/^endsAt\b/.test(message)) result.end = message;
  else if (/^startsAt\b/.test(message)) result.start = message;
  else if (/display/i.test(message)) result.displays = message;
  else if (byLabel) result.fields[byLabel.key] = message;
  else result.general = message;
  return result;
}
