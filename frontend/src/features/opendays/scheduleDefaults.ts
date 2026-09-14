export type OpenDayScheduleDefaults = {
  startTime: string;
  endTime: string;
  supervisors: number;
  trainees: number;
  supervisorRoleIds: string[];
  traineeRoleIds: string[];
};

export const standardOpenDayScheduleDefaults: OpenDayScheduleDefaults = {
  startTime: '16:00',
  endTime: '19:00',
  supervisors: 2,
  trainees: 1,
  supervisorRoleIds: [],
  traineeRoleIds: [],
};

export function scheduleDefaultsFromNavigationState(state: unknown): OpenDayScheduleDefaults | null {
  if (!state || typeof state !== 'object' || !('openDayDefaults' in state)) return null;
  const value = state.openDayDefaults;
  if (!value || typeof value !== 'object') return null;
  const defaults = value as Partial<OpenDayScheduleDefaults>;
  if (
    typeof defaults.startTime !== 'string'
    || typeof defaults.endTime !== 'string'
    || typeof defaults.supervisors !== 'number'
    || typeof defaults.trainees !== 'number'
    || !Array.isArray(defaults.supervisorRoleIds)
    || !Array.isArray(defaults.traineeRoleIds)
    || defaults.supervisorRoleIds.some((id) => typeof id !== 'string')
    || defaults.traineeRoleIds.some((id) => typeof id !== 'string')
  ) return null;
  return {
    startTime: defaults.startTime,
    endTime: defaults.endTime,
    supervisors: defaults.supervisors,
    trainees: defaults.trainees,
    supervisorRoleIds: defaults.supervisorRoleIds,
    traineeRoleIds: defaults.traineeRoleIds,
  };
}
