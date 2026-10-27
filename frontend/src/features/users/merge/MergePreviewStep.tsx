import {
  InlineNotification,
  RadioButton,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import type { PeopleMergeCandidate, PeopleMergePreview } from '../../../api/generated/models';
import { PersonAvatar } from '../PersonAvatar';
import {
  categoryLabels,
  comparedFields,
  conflictMessages,
  fieldValue,
  type FieldChoices,
  survivingAccountPersonId,
} from './mergeFields';

const name = (person: PeopleMergeCandidate) => `${person.firstName} ${person.lastName}`;

function authSummary(person: PeopleMergeCandidate): string {
  const account = person.account;
  if (!account) return 'No account';
  const methods = [
    account.passwordSet && 'password',
    account.pinEnrolled && 'PIN',
    account.oidcIdentityCount > 0 && `${account.oidcIdentityCount} single sign-on`,
    account.totpEnrolled && 'authenticator app',
    account.passkeyCount > 0 && `${account.passkeyCount} passkey${account.passkeyCount === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return methods.length ? methods.join(', ') : 'No sign-in method';
}

/** Step 2: blocking conflicts, the per-field choice, and what else is combined. */
export function MergePreviewStep({
  preview,
  choices,
  onChoose,
}: {
  preview: PeopleMergePreview;
  choices: FieldChoices;
  onChoose: (field: keyof FieldChoices, personId: string) => void;
}) {
  const byId = new Map(preview.people.map((person) => [person.id, person]));
  const fields = comparedFields(preview.people);
  const survivor = survivingAccountPersonId(preview);

  return (
    <Stack gap={6}>
      {preview.conflicts.map((conflict, index) => {
        const involved = conflict.personIds.map((id) => byId.get(id)).filter(Boolean) as PeopleMergeCandidate[];
        return (
          <InlineNotification
            key={`${conflict.code}-${index}`}
            kind="error"
            lowContrast
            hideCloseButton
            title="Cannot merge"
            subtitle={`${conflictMessages[conflict.code] ?? conflict.message}${
              involved.length ? ` (${involved.map(name).join(', ')})` : ''
            }`}
          />
        );
      })}
      <div className="people-merge__table-scroll">
        <Table size="md" aria-label="Values to keep for the merged person">
          <TableHead>
            <TableRow>
              <TableHeader>Field</TableHeader>
              {preview.people.map((person) => (
                <TableHeader key={person.id}>
                  {name(person)}
                  {person.id === preview.targetPersonId && (
                    <Tag size="sm" type="blue" className="people-merge__tag">
                      Stays
                    </Tag>
                  )}
                </TableHeader>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {fields.map(({ field, label }) => (
              <TableRow key={field}>
                <TableCell>{label}</TableCell>
                {preview.people.map((person) => {
                  const value = fieldValue(person, field);
                  // The email is the login email of the surviving account, so only people with an account qualify.
                  const disabled = field === 'email' && survivor !== null && !person.account;
                  return (
                    <TableCell key={person.id}>
                      <div className="people-merge__option">
                        <RadioButton
                          id={`merge-${field}-${person.id}`}
                          name={`merge-${field}`}
                          labelText={`${label} from ${name(person)}`}
                          hideLabel
                          disabled={disabled}
                          checked={choices[field] === person.id}
                          onChange={() => onChoose(field, person.id)}
                        />
                        {field === 'profileImage' ? (
                          <PersonAvatar
                            firstName={person.firstName}
                            lastName={person.lastName}
                            profileImage={person.profileImage}
                            size="md"
                          />
                        ) : (
                          <span className={value === null ? 'people-merge__empty' : undefined}>{value ?? 'Empty'}</span>
                        )}
                      </div>
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <StructuredListWrapper isCondensed aria-label="Merge result">
        <StructuredListBody>
          <StructuredListRow>
            <StructuredListCell noWrap>Roles</StructuredListCell>
            <StructuredListCell>
              {preview.resultingRoles.length ? preview.resultingRoles.map((role) => role.name).join(', ') : 'None'}
            </StructuredListCell>
          </StructuredListRow>
          <StructuredListRow>
            <StructuredListCell noWrap>Account that stays</StructuredListCell>
            <StructuredListCell>
              {survivor
                ? `${name(byId.get(survivor)!)} (${byId.get(survivor)!.account?.status})`
                : 'Nobody has an account'}
            </StructuredListCell>
          </StructuredListRow>
          {preview.people
            .filter((person) => person.account)
            .map((person) => (
              <StructuredListRow key={person.id}>
                <StructuredListCell noWrap>Sign-in of {name(person)}</StructuredListCell>
                <StructuredListCell>{authSummary(person)}</StructuredListCell>
              </StructuredListRow>
            ))}
          <StructuredListRow>
            <StructuredListCell noWrap>History that moves</StructuredListCell>
            <StructuredListCell>
              {preview.history.length
                ? preview.history.map((item) => `${categoryLabels[item.category]}: ${item.count}`).join(' · ')
                : 'Nothing to move'}
            </StructuredListCell>
          </StructuredListRow>
        </StructuredListBody>
      </StructuredListWrapper>
    </Stack>
  );
}
