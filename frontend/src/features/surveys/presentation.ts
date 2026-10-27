import type { SurveyShareLinkState, SurveyStatus } from '../../api/generated/models';

export const statusLabels: Record<SurveyStatus, string> = { draft: 'Draft', published: 'Published', closed: 'Closed' };
export const statusTagTypes = { draft: 'gray', published: 'green', closed: 'cool-gray' } as const;

export const linkStateLabels: Record<SurveyShareLinkState, string> = {
  open: 'Active',
  inactive: 'Deactivated',
  expired: 'Expired',
  full: 'Full',
};
export const linkStateTagTypes = { open: 'green', inactive: 'gray', expired: 'red', full: 'purple' } as const;

/** Public address of a share link; the route is chosen here, the API only knows the token. */
export const shareLinkUrl = (token: string) => `${window.location.origin}/survey/link/${token}`;
