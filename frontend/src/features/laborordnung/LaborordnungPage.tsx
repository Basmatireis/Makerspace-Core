import { useState } from 'react';
import { Button, ComposedModal, DataTable, FileUploaderDropContainer, InlineNotification, ModalBody, ModalFooter, ModalHeader, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag, TextArea, TextInput, Tile } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LaborordnungRequest, LaborordnungVersion } from '../../api/generated/models';
import { confirmLaborordnungRequest, getCreateLaborordnungVersionUrl, getGetLaborordnungPDFUrl, listLaborordnungRequests, listLaborordnungVersions, publishLaborordnungVersion } from '../../api/generated/laborordnung/laborordnung';
import { apiFetch } from '../../api/http-client';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';

const keys = { versions: ['laborordnung', 'versions'] as const, requests: ['laborordnung', 'requests'] as const };

export function LaborordnungPage() {
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const canManage = hasPermission(currentUser, PermissionId.laborordnungmanage);
  const canReadQueue = hasPermission(currentUser, PermissionId.laborordnungrequestsread);
  const canConfirm = hasPermission(currentUser, PermissionId.laborordnungconfirm);
  const versions = useQuery({ queryKey: keys.versions, queryFn: () => listLaborordnungVersions() });
  const requests = useQuery({ queryKey: keys.requests, queryFn: () => listLaborordnungRequests(), enabled: canReadQueue });
  const [revision, setRevision] = useState('');
  const [file, setFile] = useState<File>();
  const [selected, setSelected] = useState<LaborordnungRequest>();
  const [reference, setReference] = useState('');
  const [signedDate, setSignedDate] = useState('');
  const [archiveNote, setArchiveNote] = useState('');

  const upload = useMutation({
    mutationFn: () => apiFetch<LaborordnungVersion>(getCreateLaborordnungVersionUrl(), { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Human-Revision': revision.trim(), 'X-File-Name': file?.name ?? 'lab-rules.pdf' }, body: file }),
    onSuccess: async () => { setRevision(''); setFile(undefined); await queryClient.invalidateQueries({ queryKey: keys.versions }); },
  });
  const publish = useMutation({
    mutationFn: (id: string) => publishLaborordnungVersion(id, { effectiveAt: new Date().toISOString() }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: keys.versions }),
  });
  const confirm = useMutation({
    mutationFn: () => confirmLaborordnungRequest(selected!.id, { physicalDocumentReference: reference.trim(), signedDate: signedDate || null, archiveNote: archiveNote.trim() || null }),
    onSuccess: async () => { setSelected(undefined); setReference(''); setSignedDate(''); setArchiveNote(''); await queryClient.invalidateQueries({ queryKey: keys.requests }); },
  });

  return <Stack gap={7}>
    <PageHeader title="Lab Rules" breadcrumbs={[{ label: 'Settings', to: '/settings' }]} description="Published documents are immutable. Confirmation records physical evidence only." />
    {canManage && <Tile><Stack gap={5}><h2>Upload draft PDF</h2>{upload.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="PDF not accepted" subtitle="Use a valid PDF up to 25 MiB and a unique revision." />}<TextInput id="laborordnung-revision" labelText="Human revision" value={revision} onChange={(event) => setRevision(event.target.value)} /><FileUploaderDropContainer id="laborordnung-pdf" accept={['application/pdf']} maxFileSize={25 << 20} multiple={false} labelText="Drag a PDF here or click to upload" onAddFiles={(_, data) => setFile(data.addedFiles[0])} /><Button disabled={!file || !revision.trim() || upload.isPending} onClick={() => upload.mutate()}>{upload.isPending ? 'Validating…' : 'Create draft'}</Button></Stack></Tile>}
    <Tile><Stack gap={5}><h2>Version history</h2>{versions.isPending && <InlineLoadingState label="Loading versions" />}{versions.isError && <ErrorState message="Unable to load Lab Rules versions." onRetry={() => void versions.refetch()} />}{versions.data && <DataTable rows={versions.data.items.map((item) => ({ ...item, id: item.id, effective: item.effectiveAt ? new Date(item.effectiveAt).toLocaleString() : 'Not published' }))} headers={[{ key: 'humanRevision', header: 'Revision' }, { key: 'status', header: 'Status' }, { key: 'effective', header: 'Effective' }, { key: 'actions', header: 'Actions' }]}>{({ rows, headers, getTableProps, getHeaderProps, getRowProps }) => <TableContainer><Table {...getTableProps()}><TableHead><TableRow>{headers.map((header) => <TableHeader {...getHeaderProps({ header })} key={header.key}>{header.header}</TableHeader>)}</TableRow></TableHead><TableBody>{rows.map((row) => { const version = versions.data.items.find((item) => item.id === row.id)!; return <TableRow {...getRowProps({ row })} key={row.id}>{row.cells.map((cell) => <TableCell key={cell.id}>{cell.info.header === 'actions' ? <Stack orientation="horizontal" gap={3}><Button kind="ghost" size="sm" href={getGetLaborordnungPDFUrl(version.id)} target="_blank">View PDF</Button>{canManage && version.status === 'draft' && <Button kind="tertiary" size="sm" disabled={publish.isPending} onClick={() => publish.mutate(version.id)}>Publish now</Button>}</Stack> : cell.info.header === 'status' ? <Tag type={version.status === 'published' ? 'green' : 'gray'}>{version.status}</Tag> : String(cell.value ?? '')}</TableCell>)}</TableRow>; })}</TableBody></Table></TableContainer>}</DataTable>}</Stack></Tile>
    {canReadQueue && <Tile><Stack gap={5}><h2>Physical confirmation queue</h2>{requests.isPending && <InlineLoadingState label="Loading requests" />}{requests.isError && <ErrorState message="Unable to load confirmation requests." onRetry={() => void requests.refetch()} />}{requests.data && <DataTable rows={requests.data.items.map((item) => ({ id: item.id, personName: item.personName, revision: item.requiredVersion.humanRevision, status: item.status, requested: new Date(item.requestedAt).toLocaleString(), action: '' }))} headers={[{ key: 'personName', header: 'Person' }, { key: 'revision', header: 'Required revision' }, { key: 'requested', header: 'Requested' }, { key: 'status', header: 'Status' }, { key: 'action', header: '' }]}>{({ rows, headers, getTableProps, getHeaderProps, getRowProps }) => <TableContainer><Table {...getTableProps()}><TableHead><TableRow>{headers.map((header) => <TableHeader {...getHeaderProps({ header })} key={header.key}>{header.header}</TableHeader>)}</TableRow></TableHead><TableBody>{rows.map((row) => { const request = requests.data.items.find((item) => item.id === row.id)!; return <TableRow {...getRowProps({ row })} key={row.id}>{row.cells.map((cell) => <TableCell key={cell.id}>{cell.info.header === 'action' && request.status === 'pending' && canConfirm ? <Button kind="tertiary" size="sm" onClick={() => setSelected(request)}>Verify physical document</Button> : String(cell.value ?? '')}</TableCell>)}</TableRow>; })}</TableBody></Table></TableContainer>}</DataTable>}</Stack></Tile>}
    <ComposedModal open={Boolean(selected)} onClose={() => setSelected(undefined)}><ModalHeader title="Confirm physical document" /><ModalBody><Stack gap={5}><p>Confirm only after checking the signed physical document.</p>{confirm.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Confirmation failed" subtitle="The request may no longer be pending." />}<TextInput id="physical-reference" labelText="Physical document reference" value={reference} onChange={(event) => setReference(event.target.value)} /><TextInput id="signed-date" type="date" labelText="Signed date (optional)" value={signedDate} onChange={(event) => setSignedDate(event.target.value)} /><TextArea id="archive-note" labelText="Archive note (optional)" value={archiveNote} onChange={(event) => setArchiveNote(event.target.value)} /></Stack></ModalBody><ModalFooter><Button kind="secondary" onClick={() => setSelected(undefined)}>Cancel</Button><Button disabled={!reference.trim() || confirm.isPending} onClick={() => confirm.mutate()}>Confirm evidence</Button></ModalFooter></ComposedModal>
  </Stack>;
}
