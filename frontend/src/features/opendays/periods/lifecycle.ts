import {
  archiveOpenDayPeriod,
  openOpenDayPeriodForStaffing,
  publishOpenDayPeriod,
  returnOpenDayPeriodToDraft,
  returnOpenDayPeriodToStaffing,
} from '../../../api/generated/open-days/open-days';
import type { OpenDayPeriod, OpenDayPeriodStatus } from '../../../api/generated/models';

export type Transition = {
  to: OpenDayPeriodStatus;
  label: string;
  /** What the change does, shown in the confirmation. */
  effect: string;
  danger?: boolean;
  run: (period: OpenDayPeriod) => Promise<OpenDayPeriod>;
};

const withVersion = (period: OpenDayPeriod) => ({ expectedVersion: period.version });

/** The status changes a period offers from each status, in the order the panel shows them. */
export const transitions: Record<OpenDayPeriodStatus, Transition[]> = {
  draft: [
    {
      to: 'staffing',
      label: 'Start staffing',
      effect: 'Supervisors and trainees can sign up. Guests do not see it yet.',
      run: (period) => openOpenDayPeriodForStaffing(period.id, withVersion(period)),
    },
  ],
  staffing: [
    {
      to: 'published',
      label: 'Publish',
      effect: 'Guests see the open days in the public calendar.',
      run: (period) => publishOpenDayPeriod(period.id, withVersion(period)),
    },
    {
      to: 'draft',
      label: 'Back to draft',
      effect: 'Hides the period from everyone but the Leitung and closes sign-ups. Existing sign-ups are kept.',
      danger: true,
      run: (period) => returnOpenDayPeriodToDraft(period.id, withVersion(period)),
    },
  ],
  published: [
    {
      to: 'staffing',
      label: 'Return to staffing',
      effect: 'Takes it out of the public calendar; sign-ups stay open.',
      danger: true,
      run: (period) => returnOpenDayPeriodToStaffing(period.id, withVersion(period)),
    },
    {
      to: 'archived',
      label: 'Archive',
      effect: 'Ends the period for good. Nothing can change afterwards.',
      danger: true,
      run: (period) => archiveOpenDayPeriod(period.id, withVersion(period)),
    },
  ],
  archived: [],
};

export const STATUS_HINT: Record<OpenDayPeriodStatus, string> = {
  draft: 'Only the Leitung sees this period. Plan the open days, then start staffing.',
  staffing: 'Supervisors and trainees can sign up. Guests do not see it yet.',
  published: 'Guests see the open days; sign-ups stay open.',
  archived: 'The period is closed.',
};
