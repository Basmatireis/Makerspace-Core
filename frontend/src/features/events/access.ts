import type { CurrentUser } from '../../api/generated/models';
import { hasPermission, PermissionId } from '../auth/permissions';

/**
 * What the signed-in person may see and do with events. The backend enforces every rule; this only decides which
 * controls to show (frontend authorization is UX).
 */
export type EventAccess = {
  manage: boolean;
  staffing: boolean;
  assign: boolean;
  signup: boolean;
  /** Anyone who sees drafts and planning data: the people the list shows organizer columns to. */
  organizer: boolean;
  /** May open the edit mode with the planning tabs. */
  canEdit: boolean;
  /** Helper names (never contact details) are visible. */
  canSeeNames: boolean;
  /** Helper contact details are visible. */
  canSeeContacts: boolean;
};

export function eventAccess(user: CurrentUser): EventAccess {
  const manage = hasPermission(user, PermissionId.eventsmanage);
  const staffing = hasPermission(user, PermissionId.eventsstaffingmanage);
  const assign = hasPermission(user, PermissionId.eventsassign);
  const signup = hasPermission(user, PermissionId.eventssignup);
  const readAssignments = hasPermission(user, PermissionId.eventsread_assignments);
  return {
    manage,
    staffing,
    assign,
    signup,
    organizer: manage || staffing || assign,
    canEdit: manage || staffing,
    canSeeNames: staffing || assign || readAssignments,
    canSeeContacts: staffing || assign,
  };
}
