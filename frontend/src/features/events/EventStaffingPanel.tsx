import { Close, UserFollow } from '@carbon/icons-react';
import {
  Button, OverflowMenu, OverflowMenuItem, ProgressBar, StructuredListBody, StructuredListCell, StructuredListRow,
  StructuredListWrapper, Table, TableBody, TableCell, TableContainer, TableExpandedRow, TableExpandHeader, TableExpandRow,
  TableHead, TableHeader, TableRow, Tag, Tile, Toggle,
} from '@carbon/react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { cancelEventAssignment, deleteEventShiftRequirement, listEventEligibilityRoles } from '../../api/generated/events/events';
import type { EventAssignment, EventRequirement, EventShift } from '../../api/generated/models';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { EmptyState, ErrorState, InlineLoadingState } from '../../app/PageState';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { RequirementEditDialog } from './EventEditDialogs';
import { eventMutationMessage } from './errors';
import { AssignHelperDialog, RequirementCreateDialog } from './EventStaffingDialogs';
import { formatInstant } from './format';
import { eventAssignmentsQueryOptions, eventKeys, eventRequirementsQueryOptions, eventShiftsQueryOptions } from './queries';

type Dialog =
  | { kind: 'create'; shift: EventShift }
  | { kind: 'edit'; requirement: EventRequirement }
  | { kind: 'assign'; requirement: EventRequirement }
  | { kind: 'delete'; requirement: EventRequirement }
  | { kind: 'cancel'; assignment: EventAssignment };

type ShiftStaffing = { shift: EventShift; requirements: EventRequirement[]; filled: number; required: number; loading: boolean };

function staffingTag(filled: number, required: number, cancelled = false) {
  if (cancelled) return <Tag size="sm" type="gray">Cancelled</Tag>;
  if (required === 0) return <Tag size="sm" type="gray">No requirements</Tag>;
  if (filled >= required) return <Tag size="sm" type="green">Staffed</Tag>;
  return <Tag size="sm" type="red">Short {required - filled}</Tag>;
}

function staffingBar(label: string, filled: number, required: number) {
  return <ProgressBar
    size="small"
    label={label}
    hideLabel
    max={Math.max(required, 1)}
    value={Math.min(filled, Math.max(required, 1))}
    status={required > 0 && filled >= required ? 'finished' : 'active'}
    helperText={`${filled} of ${required}`}
  />;
}

function assigneeName(item: EventAssignment) {
  if (item.personalDataErasedAt) return 'Personal data erased';
  return `${item.firstName ?? ''} ${item.lastName ?? ''}`.trim() || 'Known person';
}

export function EventStaffingPanel({ eventId, canStaff, canAssign, archived }: { eventId: string; canStaff: boolean; canAssign: boolean; archived: boolean }) {
  const client = useQueryClient();
  const shifts = useQuery(eventShiftsQueryOptions(eventId));
  const assignments = useQuery(eventAssignmentsQueryOptions(eventId, canStaff || canAssign));
  const roles = useQuery({ queryKey: ['events', 'eligibility-roles'], queryFn: ({ signal }) => listEventEligibilityRoles({ signal }), enabled: canStaff });
  const requirementQueries = useQueries({ queries: (shifts.data?.items ?? []).map((shift) => eventRequirementsQueryOptions(eventId, shift.id)) });
  const [onlyShort, setOnlyShort] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogDirty, setDialogDirty] = useState(false);
  const guard = useUnsavedChanges({ isDirty: dialogDirty, onDiscard: () => { setDialog(null); setDialogDirty(false); } });
  const editable = !archived;

  const refresh = (shiftId?: string) => Promise.all([
    shiftId ? client.invalidateQueries({ queryKey: eventKeys.requirements(eventId, shiftId) }) : client.invalidateQueries({ queryKey: eventKeys.shifts(eventId) }),
    client.invalidateQueries({ queryKey: eventKeys.assignments(eventId) }),
    client.invalidateQueries({ queryKey: eventKeys.detail(eventId) }),
  ]);
  const closeDialog = () => guard.requestDiscard(() => { setDialog(null); setDialogDirty(false); });
  const finishDialog = async (shiftId: string) => { setDialog(null); setDialogDirty(false); await refresh(shiftId); };
  const removeRequirement = useMutation({
    mutationFn: (item: EventRequirement) => deleteEventShiftRequirement(eventId, item.shiftId, item.id, { expectedVersion: item.version }),
    onSuccess: async (_, item) => { if (selectedId === item.id) setSelectedId(null); await finishDialog(item.shiftId); },
  });
  const cancel = useMutation({
    mutationFn: (item: EventAssignment) => cancelEventAssignment(eventId, item.id, { expectedVersion: item.version }),
    onSuccess: async (_, item) => finishDialog(item.shiftId),
  });

  if (shifts.isPending) return <InlineLoadingState label="Loading staffing" />;
  if (shifts.isError) return <ErrorState message="Staffing could not be loaded." onRetry={() => void shifts.refetch()} />;

  const staffing: ShiftStaffing[] = shifts.data.items.map((shift, index) => {
    const requirements = requirementQueries[index]?.data?.items ?? [];
    return {
      shift,
      requirements,
      filled: requirements.reduce((sum, item) => sum + Math.min(item.filledCount, item.requiredCount), 0),
      required: requirements.reduce((sum, item) => sum + item.requiredCount, 0),
      loading: requirementQueries[index]?.isPending ?? true,
    };
  });
  const active = staffing.filter((item) => item.shift.status !== 'cancelled');
  const isShort = (item: ShiftStaffing) => item.shift.status !== 'cancelled' && item.filled < item.required;
  const totalFilled = active.reduce((sum, item) => sum + item.filled, 0);
  const totalRequired = active.reduce((sum, item) => sum + item.required, 0);
  const shortCount = active.filter(isShort).length;
  const staffedCount = active.filter((item) => item.required > 0 && item.filled >= item.required).length;
  const visible = onlyShort ? staffing.filter(isShort) : staffing;
  const allRequirements = staffing.flatMap((item) => item.requirements);
  const selected = allRequirements.find((item) => item.id === selectedId) ?? null;
  const selectedShift = selected ? staffing.find((item) => item.shift.id === selected.shiftId)?.shift : undefined;
  const selectedAssignments = selected ? (assignments.data?.items ?? []).filter((item) => item.requirementId === selected.id) : [];
  const toggleExpanded = (shiftId: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(shiftId)) next.delete(shiftId); else next.add(shiftId);
    return next;
  });

  if (staffing.length === 0) return <EmptyState title="No shifts yet" description="Add shifts in Schedule before staffing the event." />;

  return <div className="event-staffing">
    <div className="event-staffing__summary">
      <Tile><span>Filled</span><strong>{totalFilled} / {totalRequired}</strong></Tile>
      <Tile><span>Shifts short</span><strong className={shortCount > 0 ? 'event-staffing__short' : undefined}>{shortCount}</strong></Tile>
      <Tile><span>Fully staffed</span><strong>{staffedCount} of {active.length}</strong></Tile>
      <Toggle id="event-staffing-only-short" size="sm" labelText="Show" labelA="All shifts" labelB="Only understaffed" toggled={onlyShort} onToggle={setOnlyShort} />
    </div>

    <div className="event-staffing__workspace">
      <TableContainer title="Shifts" description="Expand a shift to see its requirements. Select a requirement to manage its helpers.">
        <Table size="md" aria-label="Shift staffing">
          <TableHead>
            <TableRow>
              <TableExpandHeader aria-label="Expand shift" />
              <TableHeader>Shift / requirement</TableHeader>
              <TableHeader>Filled</TableHeader>
              <TableHeader>Status</TableHeader>
              <TableHeader><span className="cds--visually-hidden">Actions</span></TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {visible.map((item) => {
              const isExpanded = expanded.has(item.shift.id);
              return [
                <TableExpandRow key={item.shift.id} isExpanded={isExpanded} onExpand={() => toggleExpanded(item.shift.id)} aria-label={`Requirements for ${item.shift.name}`}>
                  <TableCell>
                    <strong>{item.shift.name}</strong>
                    <span className="event-staffing__meta">{formatInstant(item.shift.startsAt)} – {formatInstant(item.shift.endsAt)}</span>
                  </TableCell>
                  <TableCell>{item.loading ? '…' : staffingBar(`${item.shift.name} staffing`, item.filled, item.required)}</TableCell>
                  <TableCell>{item.loading ? null : staffingTag(item.filled, item.required, item.shift.status === 'cancelled')}</TableCell>
                  <TableCell className="cds--table-column-menu">
                    {canStaff && editable && <OverflowMenu size="sm" flipped aria-label={`Actions for ${item.shift.name}`} iconDescription={`Actions for ${item.shift.name}`}>
                      <OverflowMenuItem itemText="Add requirement" onClick={() => setDialog({ kind: 'create', shift: item.shift })} />
                    </OverflowMenu>}
                  </TableCell>
                </TableExpandRow>,
                isExpanded && <TableExpandedRow key={`${item.shift.id}-requirements`} colSpan={5}>
                  {item.requirements.length === 0
                    ? <p className="event-staffing__meta">No requirements yet.{canStaff && editable ? ' Use the shift menu to add one.' : ''}</p>
                    : <Table size="sm" aria-label={`${item.shift.name} requirements`}>
                      <TableBody>
                        {item.requirements.map((requirement) => <TableRow key={requirement.id} isSelected={requirement.id === selectedId}>
                          <TableCell>
                            <Button kind="ghost" size="sm" aria-pressed={requirement.id === selectedId} onClick={() => setSelectedId(requirement.id)}>{requirement.name}</Button>
                            <span className="event-staffing__meta">{requirement.eligibilityMode === 'roles' ? 'Selected roles' : 'Anyone'}</span>
                          </TableCell>
                          <TableCell>{staffingBar(`${requirement.name} staffing`, requirement.filledCount, requirement.requiredCount)}</TableCell>
                          <TableCell>{staffingTag(requirement.filledCount, requirement.requiredCount)}</TableCell>
                          <TableCell className="cds--table-column-menu">
                            {canStaff && editable && <OverflowMenu size="sm" flipped aria-label={`Actions for ${requirement.name}`} iconDescription={`Actions for ${requirement.name}`}>
                              <OverflowMenuItem itemText="Edit requirement" onClick={() => setDialog({ kind: 'edit', requirement })} />
                              <OverflowMenuItem itemText="Delete requirement" isDelete hasDivider onClick={() => { removeRequirement.reset(); setDialog({ kind: 'delete', requirement }); }} />
                            </OverflowMenu>}
                          </TableCell>
                        </TableRow>)}
                      </TableBody>
                    </Table>}
                </TableExpandedRow>,
              ];
            })}
          </TableBody>
        </Table>
        {visible.length === 0 && <EmptyState title="Every shift is staffed" description="Turn off the filter to see all shifts." />}
      </TableContainer>

      <Tile className="event-staffing__detail" aria-live="polite">
        {!selected || !selectedShift
          ? <p className="event-staffing__meta">Select a requirement to see who is assigned.</p>
          : <>
            <div className="event-staffing__detail-heading">
              <div>
                <h3>{selected.name}</h3>
                <span className="event-staffing__meta">{selectedShift.name} · {selected.eligibilityMode === 'roles' ? 'Selected roles' : 'Anyone'}</span>
              </div>
              <Button kind="ghost" size="sm" hasIconOnly renderIcon={Close} iconDescription="Close details" onClick={() => setSelectedId(null)} />
            </div>
            {staffingBar(`${selected.name} staffing`, selected.filledCount, selected.requiredCount)}
            {selected.description && <p>{selected.description}</p>}
            {assignments.isPending && (canStaff || canAssign) && <InlineLoadingState label="Loading helpers" />}
            {selectedAssignments.length > 0
              ? <StructuredListWrapper isCondensed aria-label={`Helpers for ${selected.name}`}>
                <StructuredListBody>
                  {selectedAssignments.map((item) => <StructuredListRow key={item.id}>
                    <StructuredListCell>
                      <strong>{assigneeName(item)}</strong>
                      <span className="event-staffing__meta">{[item.email, item.phone].filter(Boolean).join(' · ') || item.source}</span>
                    </StructuredListCell>
                    <StructuredListCell><Tag size="sm" type={item.status === 'active' ? 'green' : 'gray'}>{item.status === 'active' ? 'Active' : 'Cancelled'}</Tag></StructuredListCell>
                    <StructuredListCell>{canAssign && editable && item.status === 'active' && <Button kind="danger--ghost" size="sm" onClick={() => { cancel.reset(); setDialog({ kind: 'cancel', assignment: item }); }}>Cancel</Button>}</StructuredListCell>
                  </StructuredListRow>)}
                </StructuredListBody>
              </StructuredListWrapper>
              : !assignments.isPending && <p className="event-staffing__meta">Nobody is assigned yet.</p>}
            {canAssign && editable && <Button kind="tertiary" size="md" renderIcon={UserFollow} onClick={() => setDialog({ kind: 'assign', requirement: selected })}>Assign helper</Button>}
          </>}
      </Tile>
    </div>

    {dialog?.kind === 'create' && <RequirementCreateDialog eventId={eventId} shift={dialog.shift} roles={roles.data?.items ?? []} open={!guard.dialogOpen} onDirtyChange={setDialogDirty} onClose={closeDialog} onSaved={async () => { setExpanded((current) => new Set(current).add(dialog.shift.id)); await finishDialog(dialog.shift.id); }} />}
    {dialog?.kind === 'edit' && <RequirementEditDialog key={`${dialog.requirement.id}-${dialog.requirement.version}`} eventId={eventId} requirement={dialog.requirement} roles={roles.data?.items ?? []} open={!guard.dialogOpen} onDirtyChange={setDialogDirty} onClose={closeDialog} onSaved={() => finishDialog(dialog.requirement.shiftId)} />}
    {dialog?.kind === 'assign' && <AssignHelperDialog eventId={eventId} requirement={dialog.requirement} open={!guard.dialogOpen} onDirtyChange={setDialogDirty} onClose={closeDialog} onSaved={() => finishDialog(dialog.requirement.shiftId)} />}
    <DestructiveActionDialog
      open={dialog?.kind === 'delete'}
      title={`Delete ${dialog?.kind === 'delete' ? dialog.requirement.name : 'requirement'}?`}
      confirmLabel="Delete requirement"
      pending={removeRequirement.isPending}
      error={removeRequirement.isError ? eventMutationMessage(removeRequirement.error) : undefined}
      onClose={() => { if (!removeRequirement.isPending) setDialog(null); }}
      onConfirm={() => { if (dialog?.kind === 'delete') removeRequirement.mutate(dialog.requirement); }}
    >
      <p>The staffing requirement is removed. Existing assignment references may prevent deletion.</p>
    </DestructiveActionDialog>
    <DestructiveActionDialog
      open={dialog?.kind === 'cancel'}
      title="Cancel assignment?"
      confirmLabel="Cancel assignment"
      pending={cancel.isPending}
      error={cancel.isError ? eventMutationMessage(cancel.error) : undefined}
      onClose={() => { if (!cancel.isPending) setDialog(null); }}
      onConfirm={() => { if (dialog?.kind === 'cancel') cancel.mutate(dialog.assignment); }}
    >
      <p>The helper is removed from active staffing while the assignment history remains.</p>
    </DestructiveActionDialog>
    <UnsavedChangesDialog guard={guard} />
  </div>;
}
