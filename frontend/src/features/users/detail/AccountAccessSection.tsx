import { Button, CopyButton, InlineNotification, Stack, StructuredListBody, StructuredListWrapper, Tag } from '@carbon/react';
import type { AccountSummary, Person } from '../../../api/generated/models';
import { formatDateTime } from '../../../app/dateTime';
import { DetailRow, DetailSection } from '../PersonDetailComponents';

function formatProvisioningSource(source: string): string {
  return source.replaceAll('_', ' ').replace(/^./, (value) => value.toUpperCase());
}

export function AccountAccessSection({ person, account, canReadAccounts, canCreateAccount, canEnableAccount, enablePending, onCreateAccount, onEnableAccount }: {
  person: Person;
  account: AccountSummary | undefined;
  canReadAccounts: boolean;
  canCreateAccount: boolean;
  canEnableAccount: boolean;
  enablePending: boolean;
  onCreateAccount: () => void;
  onEnableAccount: () => void;
}) {
  return (
    <DetailSection
      title="Account access"
      meta={account && <Tag type={account.status === 'enabled' ? 'green' : 'gray'}>{account.status === 'enabled' ? 'Active' : 'Inactive'}</Tag>}
    >
      {!canReadAccounts || person.account === undefined ? (
        <InlineNotification kind="info" lowContrast hideCloseButton title="Account details unavailable" subtitle="Your permissions do not include account access." />
      ) : !account ? (
        <Stack gap={5}>
          <p>This person does not have an application account.</p>
          {canCreateAccount && <Button size="sm" onClick={onCreateAccount}>Create account</Button>}
        </Stack>
      ) : (
        <Stack gap={5}>
          <StructuredListWrapper isCondensed>
            <StructuredListBody>
              <DetailRow label="Account status" value={account.status === 'enabled' ? 'Active' : 'Inactive'} />
              <DetailRow label="Provisioning source" value={formatProvisioningSource(account.provisioningSource)} />
              <DetailRow label="First sign-in" value={account.firstAuthenticatedAt ? formatDateTime(account.firstAuthenticatedAt) : 'Not yet'} />
              <DetailRow
                label="Account ID"
                value={account.id}
                monospace
                action={(
                  <CopyButton
                    size="sm"
                    iconDescription="Copy account ID"
                    feedback="Account ID copied"
                    onClick={() => void navigator.clipboard.writeText(account.id)}
                  />
                )}
              />
            </StructuredListBody>
          </StructuredListWrapper>
          {account.status === 'disabled' && canEnableAccount && (
            <div>
              <Button size="sm" disabled={enablePending} onClick={onEnableAccount}>Activate account</Button>
            </div>
          )}
        </Stack>
      )}
    </DetailSection>
  );
}
