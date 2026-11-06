import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  assignOpenDayPerson,
  joinOpenDay,
  leaveOpenDay,
  removeOpenDayAssignment,
} from '../../api/generated/open-days/open-days';
import type { OpenDay, OpenDayAssignment, OpenDayStaffRequirement, OpenDayTimeslot } from '../../api/generated/models';
import { useNotify } from '../../app/toasts';
import { dashboardKeys } from '../dashboard/queries';
import { dateOf, shortDate, timeRange } from './model/dates';
import { openDayKeys } from './queries';

type Task = { work: () => Promise<void>; failure: string };

const describe = (day: OpenDay, slot: OpenDayTimeslot) =>
  `${shortDate(dateOf(day.startsAt))} · ${timeRange(slot.startsAt, slot.endsAt)}`;

/**
 * Sign-ups act on the server at once (they are not part of the Leitung's working copy). Every change that can be taken
 * back comes with an Undo in its toast.
 */
export function useDayActions() {
  const queryClient = useQueryClient();
  const notify = useNotify();
  const mutation = useMutation<void, Error, Task>({
    mutationFn: (task) => task.work(),
    onError: (error, task) =>
      notify({ kind: 'error', title: task.failure, subtitle: error.message || 'The list is up to date now.' }),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: openDayKeys.all }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.all }),
      ]);
    },
  });
  const run = (task: Task) => mutation.mutate(task);

  const join = (day: OpenDay, slot: OpenDayTimeslot, requirement: OpenDayStaffRequirement) =>
    run({
      failure: 'This place was just taken',
      work: async () => {
        await joinOpenDay(day.id, { requirementId: requirement.id });
        notify({
          kind: 'success',
          title: `You're in · ${shortDate(dateOf(day.startsAt))}`,
          subtitle: `${timeRange(slot.startsAt, slot.endsAt)} as ${requirement.kind}`,
          action: { label: 'Undo', run: () => leave(day, slot, requirement, false) },
        });
      },
    });

  const leave = (day: OpenDay, slot: OpenDayTimeslot, requirement: OpenDayStaffRequirement, withUndo = true) =>
    run({
      failure: 'You could not leave',
      work: async () => {
        await leaveOpenDay(day.id, { timeslotId: slot.id });
        if (withUndo)
          notify({
            kind: 'info',
            title: `You left ${describe(day, slot)}`,
            subtitle: 'Your place is free for others again.',
            action: { label: 'Undo', run: () => join(day, slot, requirement) },
          });
      },
    });

  const assign = (
    day: OpenDay,
    slot: OpenDayTimeslot,
    requirement: OpenDayStaffRequirement,
    person: { personId: string; displayName: string },
  ) =>
    run({
      failure: `${person.displayName} could not be assigned`,
      work: async () => {
        const assignment = await assignOpenDayPerson(day.id, {
          requirementId: requirement.id,
          personId: person.personId,
        });
        notify({
          kind: 'success',
          title: `${person.displayName} assigned`,
          subtitle: `${describe(day, slot)} as ${requirement.kind} · they get a message`,
          action: {
            label: 'Undo',
            run: () =>
              run({
                failure: 'The assignment could not be undone',
                work: () => removeOpenDayAssignment(day.id, assignment.id),
              }),
          },
        });
      },
    });

  const remove = (
    day: OpenDay,
    slot: OpenDayTimeslot,
    requirement: OpenDayStaffRequirement,
    assignment: OpenDayAssignment,
  ) =>
    run({
      failure: `${assignment.displayName} could not be removed`,
      work: async () => {
        await removeOpenDayAssignment(day.id, assignment.id);
        notify({
          kind: 'info',
          title: `${assignment.displayName} removed`,
          subtitle: `${describe(day, slot)} · they get a message`,
          action: {
            label: 'Undo',
            run: () =>
              run({
                failure: 'The removal could not be undone',
                work: async () => {
                  await assignOpenDayPerson(day.id, { requirementId: requirement.id, personId: assignment.personId });
                },
              }),
          },
        });
      },
    });

  return { join, leave, assign, remove, busy: mutation.isPending };
}
