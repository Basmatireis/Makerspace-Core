import { useState } from 'react';
import {
  Button,
  DataTable,
  FileUploaderDropContainer,
  InlineNotification,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  TextInput,
  Tile,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LaborordnungVersion } from '../../api/generated/models';
import {
  getCreateLaborordnungVersionUrl,
  getGetLaborordnungPDFUrl,
  listLaborordnungVersions,
  publishLaborordnungVersion,
} from '../../api/generated/laborordnung/laborordnung';
import { apiFetch } from '../../api/http-client';
import { SettingsLoading, SettingsPageLayout } from '../settings/SettingsPageLayout';
import { ErrorState } from '../../app/PageState';
import { formatDateTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { SettingsTabs, type SettingsTab } from '../settings/SettingsTabs';
import { laborordnungKeys } from './queries';
import { ConfirmationsPanel } from './ConfirmationsPanel';

const keys = laborordnungKeys;

export function LaborordnungPage() {
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const canManage = hasPermission(currentUser, PermissionId.laborordnungmanage);
  const canReadConfirmations = hasPermission(currentUser, PermissionId.laborordnungconfirmationsread);
  const versions = useQuery({ queryKey: keys.versions, queryFn: () => listLaborordnungVersions() });
  const [revision, setRevision] = useState('');
  const [file, setFile] = useState<File>();

  const upload = useMutation({
    mutationFn: () =>
      apiFetch<LaborordnungVersion>(getCreateLaborordnungVersionUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/pdf',
          'X-Human-Revision': revision.trim(),
          'X-File-Name': file?.name ?? 'lab-rules.pdf',
        },
        body: file,
      }),
    onSuccess: async () => {
      setRevision('');
      setFile(undefined);
      await queryClient.invalidateQueries({ queryKey: keys.versions });
    },
  });
  const publish = useMutation({
    mutationFn: (id: string) => publishLaborordnungVersion(id, { effectiveAt: new Date().toISOString() }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: keys.versions }),
  });
  const documents = (
    <div className="settings-section">
      {canManage && (
        <Tile>
          <Stack gap={5}>
            <h2>Upload draft PDF</h2>
            {upload.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="PDF not accepted"
                subtitle="Use a valid PDF up to 25 MiB and a unique revision."
              />
            )}
            <TextInput
              id="laborordnung-revision"
              labelText="Human revision"
              value={revision}
              onChange={(event) => setRevision(event.target.value)}
            />
            <FileUploaderDropContainer
              id="laborordnung-pdf"
              accept={['application/pdf']}
              maxFileSize={25 << 20}
              multiple={false}
              labelText="Drag a PDF here or click to upload"
              onAddFiles={(_, data) => setFile(data.addedFiles[0])}
            />
            <Button disabled={!file || !revision.trim() || upload.isPending} onClick={() => upload.mutate()}>
              {upload.isPending ? 'Validating…' : 'Create draft'}
            </Button>
          </Stack>
        </Tile>
      )}
      <Tile>
        <Stack gap={5}>
          <h2>Version history</h2>
          {versions.isPending && <SettingsLoading label="Loading versions" />}
          {versions.isError && (
            <ErrorState message="Unable to load Lab Rules versions." onRetry={() => void versions.refetch()} />
          )}
          {versions.data && (
            <DataTable
              rows={versions.data.items.map((item) => ({
                ...item,
                id: item.id,
                effective: item.effectiveAt ? formatDateTime(item.effectiveAt) : 'Not published',
              }))}
              headers={[
                { key: 'humanRevision', header: 'Revision' },
                { key: 'status', header: 'Status' },
                { key: 'effective', header: 'Effective' },
                { key: 'actions', header: 'Actions' },
              ]}
            >
              {({ rows, headers, getTableProps, getHeaderProps, getRowProps }) => (
                <TableContainer>
                  <Table {...getTableProps()}>
                    <TableHead>
                      <TableRow>
                        {headers.map((header) => (
                          <TableHeader {...getHeaderProps({ header })} key={header.key}>
                            {header.header}
                          </TableHeader>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {rows.map((row) => {
                        const version = versions.data.items.find((item) => item.id === row.id)!;
                        return (
                          <TableRow {...getRowProps({ row })} key={row.id}>
                            {row.cells.map((cell) => (
                              <TableCell key={cell.id}>
                                {cell.info.header === 'actions' ? (
                                  <Stack orientation="horizontal" gap={3}>
                                    <Button
                                      kind="ghost"
                                      size="sm"
                                      href={getGetLaborordnungPDFUrl(version.id)}
                                      target="_blank"
                                    >
                                      View PDF
                                    </Button>
                                    {canManage && version.status === 'draft' && (
                                      <Button
                                        kind="tertiary"
                                        size="sm"
                                        disabled={publish.isPending}
                                        onClick={() => publish.mutate(version.id)}
                                      >
                                        Publish now
                                      </Button>
                                    )}
                                  </Stack>
                                ) : cell.info.header === 'status' ? (
                                  <Tag type={version.status === 'published' ? 'green' : 'gray'}>{version.status}</Tag>
                                ) : (
                                  String(cell.value ?? '')
                                )}
                              </TableCell>
                            ))}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </DataTable>
          )}
        </Stack>
      </Tile>
    </div>
  );
  const tabs: SettingsTab[] = [
    { key: 'documents', label: 'Documents', panel: documents },
    ...(canReadConfirmations
      ? [
          {
            key: 'confirmations',
            label: 'Confirmations',
            panel: <ConfirmationsPanel versions={versions.data?.items ?? []} />,
          },
        ]
      : []),
  ];

  return (
    <SettingsPageLayout page="laborordnung">
      {tabs.length > 1 ? <SettingsTabs label="Lab Rules sections" tabs={tabs} /> : documents}
    </SettingsPageLayout>
  );
}
