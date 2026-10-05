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
