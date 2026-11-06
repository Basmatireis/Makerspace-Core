import {
  DataTable,
  Link,
  Pagination,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableExpandedRow,
  TableExpandHeader,
  TableExpandRow,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Fragment } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import type {
  NotificationActivityFiring,
  NotificationActivityFiringResult,
  NotificationActivityRecipient,
  NotificationActivityRecipientStatus,
} from '../../api/generated/models';
import { FuzzyComboBox } from '../../app/components/FuzzyComboBox';
import { EmptyState } from '../../app/PageState';
import { formatDateTime } from '../../app/dateTime';
import { channelIcons } from './editor/channelIcons';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { useServerTableState } from '../machinelogbook/shared/DirectoryTable';
import { activityQuery, rulesQuery } from './queries';
import { channelLabel } from './ruleModel';

type TagType = 'green' | 'purple' | 'gray' | 'cool-gray' | 'blue' | 'teal';

/** How each result of a firing reads, and the Carbon tag colour that goes with it. */
const resultTags: Record<NotificationActivityFiringResult, { label: string; type: TagType }> = {
  delivered: { label: 'Delivered', type: 'green' },
  escalated: { label: 'Escalated', type: 'purple' },
  throttled: { label: 'Throttled', type: 'gray' },
  skipped: { label: 'Skipped', type: 'cool-gray' },
  test: { label: 'Test', type: 'blue' },
  resolved: { label: 'Resolved', type: 'teal' },
};

/** What happened to one recipient. */
const recipientStatusTags: Record<NotificationActivityRecipientStatus, { label: string; type: TagType }> = {
  sent: { label: 'Sent', type: 'green' },
  fallback: { label: 'Sent as e-mail instead', type: 'blue' },
  throttled: { label: 'Throttled', type: 'gray' },
  skipped_consent: { label: 'Skipped: did not allow it', type: 'cool-gray' },
  skipped_muted: { label: 'Skipped: muted', type: 'cool-gray' },
  skipped_condition: { label: 'Skipped: conditions not met', type: 'cool-gray' },
  skipped_offline: { label: 'Skipped: not online', type: 'cool-gray' },
};

const triggerLabels = { event: 'Event', schedule: 'Schedule', manual: 'By hand' } as const;

const stepLabel = (step: number) => (step === 0 ? 'First message' : `Escalation step ${step}`);

/** The firing as a few dated lines: when it fired, each step that sent, and how it ended. */
function timeline(firing: NotificationActivityFiring): { time: string; text: string }[] {
  const lines = [{ time: firing.createdAt, text: `${triggerLabels[firing.trigger]}: ${firing.summary}` }];
  const steps = [...new Set(firing.recipients.map((recipient) => recipient.step))].sort((a, b) => a - b);
  for (const step of steps) {
    const sends = firing.recipients.filter((recipient) => recipient.step === step);
    const reached = sends.filter((recipient) => recipient.status === 'sent' || recipient.status === 'fallback').length;
    const first = sends.map((recipient) => recipient.sentAt).sort()[0];
    lines.push({
      time: first,
      text: `${stepLabel(step)}: ${reached} of ${sends.length} ${sends.length === 1 ? 'recipient' : 'recipients'} reached`,
    });
  }
  if (firing.resolvedReason) lines.push({ time: firing.createdAt, text: `Ended: ${firing.resolvedReason}` });
  return lines;
}

function RecipientTable({ recipients }: { recipients: NotificationActivityRecipient[] }) {
  return (
    <Table size="sm" aria-label="Recipients" useZebraStyles={false}>
      <TableHead>
        <TableRow>
          <TableHeader>Recipient</TableHeader>
          <TableHeader>Channel</TableHeader>
          <TableHeader>Outcome</TableHeader>
          <TableHeader>Sent</TableHeader>
          <TableHeader>Read</TableHeader>
          <TableHeader>Step</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {recipients.map((recipient, index) => {
          const status = recipientStatusTags[recipient.status];
          return (
            <TableRow key={`${recipient.name}-${recipient.channel}-${recipient.step}-${index}`}>
              <TableCell>{recipient.name}</TableCell>
              <TableCell>{channelLabel(recipient.channel)}</TableCell>
              <TableCell>
                <Tag size="sm" type={status.type}>
                  {status.label}
                </Tag>
              </TableCell>
              <TableCell>{formatDateTime(recipient.sentAt)}</TableCell>
              <TableCell>{recipient.readAt ? formatDateTime(recipient.readAt) : '—'}</TableCell>
              <TableCell>{stepLabel(recipient.step)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function ChannelIcons({ channels }: { channels: NotificationActivityFiring['channels'] }) {
  return (
    <span className="nc-channels">
      {channels.map((channel) => {
        const Icon = channelIcons[channel];
        return (
          <span key={channel} title={channelLabel(channel)}>
            {Icon ? <Icon size={16} aria-label={channelLabel(channel)} /> : channelLabel(channel)}
          </span>
        );
      })}
    </span>
  );
}

const pageSizes = [10, 25, 50];

/** Every time a rule fired, newest first, with the people it reached. */
export function ActivityTab() {
  const table = useServerTableState('activity-', { key: 'when', direction: 'DESC' }, pageSizes);
  const ruleId = table.url.get('rule') || undefined;
  const rules = useQuery(rulesQuery());
  const activity = useQuery(activityQuery({ ruleId, page: table.page, pageSize: table.pageSize }));
  const options = (rules.data?.items ?? []).map((rule) => ({ id: rule.id, label: rule.name }));
  const selected = options.find((option) => option.id === ruleId) ?? null;

  return (
    <QueryBoundary query={activity} errorMessage="The activity could not be loaded.">
      {(data) => {
        const byId = new Map(data.items.map((firing) => [firing.id, firing]));
        const headers = [
          { key: 'when', header: 'When' },
          { key: 'rule', header: 'Rule' },
          { key: 'what', header: 'What happened' },
          { key: 'channels', header: 'Channels' },
          { key: 'reached', header: 'Reached' },
          { key: 'result', header: 'Result' },
        ];
        return (
          <div className="nc-activity">
            <p className="nc-intro">
              Every time a rule fired in the last 90 days. Per recipient, <strong>Sent</strong> is when the message went
              out and <strong>Read</strong> when the person read, acknowledged or dismissed it.
            </p>
            <div className="nc-activity__filter">
              <FuzzyComboBox<{ id: string; label: string }>
                id="activity-rule"
                titleText="Rule"
                placeholder="All rules"
                items={options}
                itemToString={(option) => option?.label ?? ''}
                selectedItem={selected}
                onChange={({ selectedItem }) => table.url.set({ rule: selectedItem?.id ?? null })}
              />
            </div>
            <DataTable
              key={`${table.page}-${table.pageSize}-${ruleId ?? ''}`}
              rows={data.items.map((firing) => ({ id: firing.id }))}
              headers={headers}
            >
              {({ rows, headers: tableHeaders, getRowProps, getTableProps }) => (
                <TableContainer className="mj-table-container">
                  <Table {...getTableProps()} aria-label="Notification activity">
                    <TableHead>
                      <TableRow>
                        <TableExpandHeader aria-label="Details" />
                        {tableHeaders.map((header) => (
                          <TableHeader key={header.key}>{header.header}</TableHeader>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {rows.map((row) => {
                        const firing = byId.get(row.id);
                        if (!firing) return null;
                        const result = resultTags[firing.result];
                        const { key, ...rowProps } = getRowProps({ row });
                        return (
                          <Fragment key={key}>
                            <TableExpandRow
                              {...rowProps}
                              aria-label={`Show who ${firing.ruleName} reached at ${formatDateTime(firing.createdAt)}`}
                            >
                              <TableCell>{formatDateTime(firing.createdAt)}</TableCell>
                              <TableCell>
                                <Link as={RouterLink} to={`/settings/notifications/rules/${firing.ruleId}`}>
                                  {firing.ruleName}
                                </Link>
                              </TableCell>
                              <TableCell>
                                <div className="mj-cell-stack">
                                  <span>{firing.summary}</span>
                                  <span className="mj-secondary">{triggerLabels[firing.trigger]}</span>
                                </div>
                              </TableCell>
                              <TableCell>
                                <ChannelIcons channels={firing.channels} />
                              </TableCell>
                              <TableCell>{firing.reached}</TableCell>
                              <TableCell>
                                <Tag size="sm" type={result.type}>
                                  {result.label}
                                </Tag>
                              </TableCell>
                            </TableExpandRow>
                            {row.isExpanded && (
                              <TableExpandedRow colSpan={tableHeaders.length + 1}>
                                <div className="nc-activity__detail">
                                  <ul className="nc-timeline" aria-label="Timeline">
                                    {timeline(firing).map((line, index) => (
                                      <li key={index}>
                                        <span className="nc-timeline__time">{formatDateTime(line.time)}</span>
                                        <span>{line.text}</span>
                                      </li>
                                    ))}
                                  </ul>
                                  {firing.recipients.length > 0 ? (
                                    <RecipientTable recipients={firing.recipients} />
                                  ) : (
                                    <p className="nc-note">No individual recipients were recorded.</p>
                                  )}
                                </div>
                              </TableExpandedRow>
                            )}
                          </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                  {data.total === 0 && (
                    <EmptyState
                      title={ruleId ? 'Nothing from this rule' : 'No activity yet'}
                      description="Rules show up here every time they fire, for 90 days."
                    />
                  )}
                  <Pagination
                    page={table.page}
                    pageSize={table.pageSize}
                    pageSizes={pageSizes}
                    totalItems={data.total}
                    onChange={({ page, pageSize }) => table.url.set({ page: String(page), pageSize: String(pageSize) })}
                  />
                </TableContainer>
              )}
            </DataTable>
          </div>
        );
      }}
    </QueryBoundary>
  );
}
