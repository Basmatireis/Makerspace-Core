import './styles.scss';
import './catalog.scss';
import { Button, StructuredListBody, StructuredListWrapper } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { DetailRow, DetailSection } from '../../app/DetailSection';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { machineQuery } from './queries';
import { formatDateTime, formatDecimal, formatDuration } from './formatting';
import { MachineEditor } from './MachineEditor';
import { MachinePageShell } from './MachinePageShell';

export function MachineDetailPage() {
  const { machineId = '' } = useParams();
  const currentUser = useCurrentUser();
  const query = useQuery(machineQuery(machineId));
  // Capture the edit version once: background updates never replace the draft.
  const [editing, setEditing] = useState<typeof query.data>();
  if (query.isPending) return <FullPageLoading label="Loading machine" />;
  if (!query.data) return <ErrorState message="This machine could not be loaded." onRetry={() => query.refetch()} />;
  const machine = query.data;
  return <MachinePageShell machine={machine} actions={hasPermission(currentUser, PermissionId.machinesmanage) && <Button onClick={() => setEditing(machine)}>Edit machine</Button>}><div className="detail-grid"><DetailSection title="Machine details"><StructuredListWrapper isCondensed><StructuredListBody><DetailRow label="Type" value={machine.machineType.name} /><DetailRow label="Administrative status" value={machine.status} /><DetailRow label="Collection" value={machine.automaticCollectionEnabled ? 'Automatic' : 'Manual only'} /><DetailRow label="External identifier" value={machine.externalIdentifier || '—'} /><DetailRow label="Last ingest" value={machine.lastIngestedAt ? formatDateTime(machine.lastIngestedAt) : '—'} /></StructuredListBody></StructuredListWrapper></DetailSection><DetailSection title="Activity"><StructuredListWrapper isCondensed><StructuredListBody><DetailRow label="Jobs" value={machine.jobCount} /><DetailRow label="Total runtime" value={formatDuration(machine.runtimeSeconds)} /><DetailRow label="Failure rate" value={`${formatDecimal(machine.failureRate)}%`} /><DetailRow label="Created" value={formatDateTime(machine.createdAt)} /><DetailRow label="Updated" value={formatDateTime(machine.updatedAt)} /></StructuredListBody></StructuredListWrapper></DetailSection></div>{editing && <MachineEditor machine={editing} onClose={() => setEditing(undefined)} />}</MachinePageShell>;
}
