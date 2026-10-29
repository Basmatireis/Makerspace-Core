import './styles.scss';
import { useState } from 'react';
import {
  Button,
  DataTable,
  DataTableSkeleton,
  InlineNotification,
  OverflowMenu,
  OverflowMenuItem,
  Pagination,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { SentNotificationMessage } from '../../api/generated/models';
import { formatDateTime } from '../../app/dateTime';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { EditMessageModal } from './EditMessageModal';
import { NewMessageModal } from './NewMessageModal';
import { sentMessagesQuery } from './queries';
import { RetractMessageModal } from './RetractMessageModal';

const headers = [
  { key: 'message', header: 'Message' },
  { key: 'roles', header: 'Sent to' },
  { key: 'recipients', header: 'Recipients' },
  { key: 'read', header: 'Read' },
  { key: 'sent', header: 'Sent' },
];

/** Messages sent to roles, and the dialog to write a new one. Needs `notifications.send`. */
export function MessagesPage() {
  const user = useCurrentUser();
  const canSend = hasPermission(user, PermissionId.notificationssend);
  const canListRoles = hasPermission(user, PermissionId.rolesread);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [composing, setComposing] = useState(false);
  const [editing, setEditing] = useState<SentNotificationMessage | null>(null);
  const [retracting, setRetracting] = useState<SentNotificationMessage | null>(null);
  const sent = useQuery({ ...sentMessagesQuery(page, pageSize), enabled: canSend });
  const crumbs = [{ label: 'Directory' }];
  const actions = canSend ? (
    <Button renderIcon={Add} onClick={() => setComposing(true)}>
      New message
    </Button>
  ) : undefined;

  if (!canSend) {
    return (
      <PageShell title="Messages" width="wide" breadcrumbs={crumbs}>
        <EmptyState
          title="Messages cannot be shown"
          description="Sending messages needs the permission to send in-app messages. Ask an administrator to add it to your role."
        />
      </PageShell>
    );
  }

  const items = sent.data?.items ?? [];
  const rows = items.map((item) => ({
    id: item.id,
    message: item.title,
    roles: item.roles.map((role) => role.name).join(', '),
    recipients: String(item.recipientCount),
    read: String(item.readCount),
    sent: item.createdAt,
  }));

  return (
    <PageShell
      title="Messages"
      width="wide"
      breadcrumbs={crumbs}
      description="In-app messages to everyone who holds a role. They show up in the notifications of the header for 90 days."
      actions={actions}
    >
      {sent.isPending && (
        <DataTableSkeleton columnCount={headers.length} rowCount={5} showHeader={false} showToolbar={false} />
      )}
      {sent.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Messages could not be loaded"
          subtitle="Try again later."
        />
      )}
      {sent.isSuccess && items.length === 0 && (
        <EmptyState
          title="No messages sent"
          description="Messages you send to roles are listed here with how many people read them."
        />
      )}
      {sent.isSuccess && items.length > 0 && (
        <DataTable rows={rows} headers={headers}>
          {({ rows: tableRows, headers: tableHeaders, getRowProps, getTableProps }) => (
            <TableContainer description="Counts leave out people who dismissed the message.">
              <Table {...getTableProps()} aria-label="Sent messages">
                <TableHead>
                  <TableRow>
                    {tableHeaders.map((header) => (
                      <TableHeader key={header.key}>{header.header}</TableHeader>
                    ))}
                    <TableHeader>
                      <span className="cds--visually-hidden">Actions</span>
                    </TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {tableRows.map((row) => {
                    const item = items.find((candidate) => candidate.id === row.id);
                    if (!item) return null;
                    const { key, ...rowProps } = getRowProps({ row });
                    return (
                      <TableRow key={key} {...rowProps}>
                        <TableCell>
                          <div className="notification-sent__message">
                            <strong>{item.title}</strong>
                            <span className="notification-sent__body">{item.body}</span>
                          </div>
                        </TableCell>
                        <TableCell>{item.roles.map((role) => role.name).join(', ') || '–'}</TableCell>
                        <TableCell>{item.recipientCount}</TableCell>
                        <TableCell>{item.readCount}</TableCell>
                        <TableCell>
                          {formatDateTime(item.createdAt)}
                          {item.senderName ? ` · ${item.senderName}` : ''}
                        </TableCell>
                        <TableCell className="cds--table-column-menu">
                          <OverflowMenu size="sm" flipped iconDescription={`Actions for ${item.title}`}>
                            <OverflowMenuItem itemText="Edit" onClick={() => setEditing(item)} />
                            <OverflowMenuItem
                              itemText="Retract"
                              isDelete
                              hasDivider
                              onClick={() => setRetracting(item)}
                            />
                          </OverflowMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <Pagination
                page={page}
                pageSize={pageSize}
                pageSizes={[25, 50, 100]}
                totalItems={sent.data.total}
                onChange={({ page: nextPage, pageSize: nextSize }) => {
                  setPage(nextSize === pageSize ? nextPage : 1);
                  setPageSize(nextSize);
                }}
              />
            </TableContainer>
          )}
        </DataTable>
      )}
      {editing && <EditMessageModal message={editing} onClose={() => setEditing(null)} />}
      {retracting && <RetractMessageModal message={retracting} onClose={() => setRetracting(null)} />}
      {composing && <NewMessageModal canListRoles={canListRoles} onClose={() => setComposing(false)} />}
    </PageShell>
  );
}
