import { Link as CarbonLink, Tag } from '@carbon/react';
import type { LaborordnungStatus, Person } from '../../../api/generated/models';
import { PersonAvatar } from '../PersonAvatar';
import { LabRulesStatusTag } from './LabRulesStatusTag';

/** Content of one People table cell; the cell's column decides how its value is shown. */
export function PeopleCell({ column, value, rowId, person, supervisorRoleIds, labRules, onOpenPerson }: {
  column: string;
  value: unknown;
  rowId: string;
  person: Person | undefined;
  supervisorRoleIds: ReadonlySet<string>;
  labRules: { status?: LaborordnungStatus; pending: boolean; failed: boolean };
  onOpenPerson: (personId: string) => void;
}) {
  if (column === 'avatar') {
    return person ? <PersonAvatar firstName={person.firstName} lastName={person.lastName} profileImage={person.profileImage} size="sm" decorative /> : null;
  }
  if (column === 'name') {
    return (
      <CarbonLink
        href={`/people/${rowId}`}
        onClick={(event) => {
          event.preventDefault();
          onOpenPerson(rowId);
        }}
      >
        {String(value)}
      </CarbonLink>
    );
  }
  if (column === 'status' && value !== 'No account' && value !== 'Restricted') {
    return (
      <Tag type={value === 'Active' ? 'green' : 'gray'}>
        {String(value)}
      </Tag>
    );
  }
  if (column === 'roles') {
    if (!person || person.roles.length === 0) {
      return String(value);
    }
    return (
      <div className="people-table__roles" aria-label={`Roles for ${person.firstName} ${person.lastName}`}>
        {person.roles.map((role) => {
          const isSupervisorRole = supervisorRoleIds.has(role.id);
          return (
            <Tag
              key={role.id}
              type={isSupervisorRole ? 'blue' : 'gray'}
              title={isSupervisorRole ? `${role.name} is a supervisor role` : role.name}
              aria-label={isSupervisorRole ? `${role.name}, supervisor role` : role.name}
            >
              {role.name}
            </Tag>
          );
        })}
      </div>
    );
  }
  if (column === 'labRules') {
    return <LabRulesStatusTag status={labRules.status} pending={labRules.pending} failed={labRules.failed} />;
  }
  return String(value);
}
