import { hasPermission } from '../../auth/permissions';
import type { GuideDefinition } from '../types';

const canManage = (user: Parameters<GuideDefinition['requires']>[0]) => hasPermission(user, 'open_days.manage');

export const staffingGuides: GuideDefinition[] = [
  {
    id: 'staffing-tour',
    suggestOn: /^\/people\/staffing/,
    area: 'open-days',
    title: 'Staffing tour',
    summary: 'See who is below their open day minimum, act on a person and read the staffing rules.',
    duration: '3 min',
    kind: 'tour',
    demo: false,
    requires: (user) => hasPermission(user, 'supervisor_dashboard.read'),
    steps: [
      {
        id: 'nav-staffing',
        title: 'Go to Staffing',
        body: 'Staffing is in the People menu. Click it to continue.',
        route: '/dashboard',
        target: '[data-guide="nav-people-staffing"]',
        placement: 'right',
        advance: { kind: 'route', pattern: /^\/people\/staffing/ },
      },
      {
        id: 'sections',
        title: 'People and Rules',
        body: 'People shows every supervisor and trainee against their minimum for a semester. Rules holds the minimums and counting rules behind it.',
        target: '[aria-label="Staffing sections"]',
        placement: 'bottom',
      },
      {
        id: 'tiles',
        title: 'At a glance',
        body: 'The tiles count how many people are below their minimum, ready for supervisor and so on. Click a tile to filter the table to those people; click it again to clear.',
        target: 'section[aria-label="At a glance"]',
        placement: 'bottom',
        highlight: 'element',
      },
      {
        id: 'table',
        title: 'The people table',
        body: 'Search by name, narrow the table with the Filters button, sort by a column heading and export what you see as CSV. Choose another semester above the tiles.',
        target: '.st-table',
        placement: 'top',
        highlight: 'element',
      },
      {
        id: 'row',
        title: 'Open a person',
        body: 'Click a row to see that person in the panel.',
        target: '.st-table tbody tr',
        placement: 'bottom',
        advance: { kind: 'click' },
      },
      {
        id: 'panel',
        title: 'The person panel',
        body: 'It shows the progress against the minimum, the next open day, the Lab Rules status and the open days they are signed up for.\n\nThe menu in the panel header changes the membership (Supervisor, Trainee or Visitor) and excuses someone for the semester, so their minimum drops to zero. "Assign to an open day" puts them into a free place.',
        target: 'aside[aria-label="Person details"]',
        placement: 'left',
        highlight: 'element',
      },
      {
        id: 'rules-tab',
        title: 'Open the rules',
        body: 'Click "Rules".',
        target: '[aria-label="Staffing sections"] [role="tab"]:not([aria-selected="true"])',
        placement: 'bottom',
        advance: { kind: 'click' },
      },
      {
        id: 'rules',
        title: 'Staffing rules',
        body: 'Set the open days per semester for supervisors and trainees, after how many open days a trainee is ready for supervisor, how a day is counted and how many days ahead an empty place raises a warning. Exceptions give people with a certain extra role a lower minimum.',
        target: '.st-rules',
        placement: 'top',
        highlight: 'element',
      },
      {
        id: 'edit-rules',
        title: 'Saving changes',
        body: 'Changes apply when you save them. Only people who manage open days can change the rules.',
        requires: canManage,
      },
    ],
  },
];
