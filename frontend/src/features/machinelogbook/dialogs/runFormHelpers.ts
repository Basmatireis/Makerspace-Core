import { useFormContext, useWatch } from 'react-hook-form';
import type { MachineRunOutcome } from '../../../api/generated/models';
import { instantToZonedDateTimeValue, isZonedDateTimeValue, zonedDateTimeValueToISO } from '../../../app/dateTime';
import { outcomeOptions } from '../shared/status';

/** Start, runtime and outcome of one manual run. The API stores start and end; the forms ask for start + runtime. */
export type RunValues = { startsAt: string; runtimeHours: number; runtimeMinutes: number; outcome: MachineRunOutcome | '' };

export const runOutcomeChoices = outcomeOptions.filter((option) => option.id !== 'unknown') as { id: MachineRunOutcome; label: string }[];

/** Form defaults for a run; without values a new run that started an hour ago and took an hour. */
export function runDefaults(source?: { startsAt: string; endsAt: string; outcome: MachineRunOutcome | null }, fresh = true): RunValues {
  const minutes = source ? Math.max(1, Math.round((new Date(source.endsAt).getTime() - new Date(source.startsAt).getTime()) / 60_000)) : 60;
  return {
    startsAt: instantToZonedDateTimeValue(source?.startsAt ?? new Date(Date.now() - 3_600_000)),
    runtimeHours: Math.floor(minutes / 60),
    runtimeMinutes: minutes % 60,
    // A new run that already ended starts as successful; an existing run keeps what it has (nothing recorded stays empty).
    outcome: source ? source.outcome ?? '' : fresh ? 'successful' : '',
  };
}

export function endFrom(startsAt: string, hours: number, minutes: number): string | null {
  if (!isZonedDateTimeValue(startsAt)) return null;
  const total = (Number(hours) || 0) * 60 + (Number(minutes) || 0);
  return total > 0 ? new Date(new Date(zonedDateTimeValueToISO(startsAt)).getTime() + total * 60_000).toISOString() : null;
}

/** Start and end as ISO strings, or an error text. Untouched values keep the exact times the run has. */
export function resolveTimes(values: RunValues, original?: { startsAt: string; endsAt: string }): { startsAt: string; endsAt: string } | { error: string } {
  if (original) {
    const initial = runDefaults({ ...original, outcome: null });
    if (values.startsAt === initial.startsAt && Number(values.runtimeHours) === initial.runtimeHours && Number(values.runtimeMinutes) === initial.runtimeMinutes) return original;
  }
  const endsAt = endFrom(values.startsAt, values.runtimeHours, values.runtimeMinutes);
  if (!endsAt) return { error: 'Enter a valid start time and a runtime longer than zero.' };
  try {
    return { startsAt: zonedDateTimeValueToISO(values.startsAt), endsAt };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'Check the start time.' };
  }
}

/** Where the run ends and whether that lies ahead; the outcome only exists once a run has ended. */
export function useRunPreview(): { end: string | null; inFuture: boolean } {
  const { control } = useFormContext<RunValues>();
  const [startsAt, hours, minutes] = useWatch({ control, name: ['startsAt', 'runtimeHours', 'runtimeMinutes'] });
  const end = endFrom(startsAt, hours, minutes);
  return { end, inFuture: !!end && new Date(end).getTime() > Date.now() };
}
