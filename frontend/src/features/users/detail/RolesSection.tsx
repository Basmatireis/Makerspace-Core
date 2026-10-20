import { Button, DismissibleTag, Tag } from '@carbon/react';
import type { Person, Role } from '../../../api/generated/models';
import { canManageRoleMembership } from '../../auth/permissions';
import type { useCurrentUser } from '../../auth/auth';
import { DetailSection } from '../PersonDetailComponents';

export function RolesSection({ person, currentUser, rolesById, canAssignRole, onManageRoles, onRemoveRole }: {
  person: Person;
  currentUser: ReturnType<typeof useCurrentUser>;
  rolesById: ReadonlyMap<string, Role>;
  canAssignRole: boolean;
  onManageRoles: () => void;
  onRemoveRole: (role: Person['roles'][number]) => void;
}) {
  return (
    <DetailSection
      title="Roles"
      meta={<span className="section-description">{person.roles.length} assigned</span>}
      action={canAssignRole ? <Button kind="ghost" size="sm" onClick={onManageRoles}>Manage roles</Button> : undefined}
    >
      <div className="tag-list" aria-label="Assigned roles">
        {person.roles.length === 0 && <span>No roles assigned</span>}
        {person.roles.map((role) => {
          const roleDetails = rolesById.get(role.id);
          const mayRemove = Boolean(roleDetails && canManageRoleMembership(currentUser, roleDetails));
          if (mayRemove) {
            return <DismissibleTag key={role.id} type={role.systemKey === 'master' ? 'purple' : 'blue'} text={role.name} title={`Remove ${role.name} role`} dismissTooltipLabel={`Remove ${role.name} role`} onClose={() => { onRemoveRole(role); }} />;
          }
          return <Tag key={role.id} type={role.systemKey === 'master' ? 'purple' : 'blue'}>{role.name}</Tag>;
        })}
      </div>
    </DetailSection>
  );
}
