import { Add, InformationFilled, UserFollow, WarningAltFilled } from '@carbon/icons-react';
import {
  Button,
  InlineNotification,
  OverflowMenu,
  OverflowMenuItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  Tile,
  Toggle,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { cancelEventAssignment } from '../../../api/generated/events/events';
import type {
  Event,
  EventAssignmentSource,
  EventHelper,
  EventHelperShift,
  EventShift,
} from '../../../api/generated/models';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { EmptyState, ErrorState, InlineLoadingState } from '../../../app/PageState';
import { SectionSwitcher } from '../../../app/SectionSwitcher';
import { FillMeter } from '../components/FillMeter';
import { SectionHeading, SummaryTiles, TabToolbar } from '../components/Layout';
import { AssignDialog, type MoveTarget } from '../dialogs/AssignDialog';
import { LinkPersonDialog } from '../dialogs/LinkPersonDialog';
import { eventMutationMessage } from '../errors';
import { fmtDay, fmtRange, plural } from '../format';
import { closedNotice, isClosed } from '../logic';
import { eventHelpersQueryOptions, eventShiftsQueryOptions, invalidateEvents } from '../queries';

const SOURCE: Record<EventAssignmentSource, { label: string; type: 'blue' | 'teal' | 'cool-gray' }> = {
  public_signup: { label: 'Public signup', type: 'blue' },
  authenticated_self: { label: 'Member', type: 'teal' },
  authenticated_on_behalf: { label: 'Member', type: 'teal' },
  staff_entry: { label: 'Staff', type: 'cool-gray' },
};

type Entry = { helper: EventHelper; shift: EventHelperShift };
type Dialog =
  | { kind: 'assign'; shiftId?: string; requirementId?: string }
  | { kind: 'move'; target: MoveTarget }
  | { kind: 'link'; entry: Entry; suggestions: import('../../../api/generated/models').EventPersonOption[] }
  | { kind: 'cancel'; entry: Entry };

const contactOf = (helper: EventHelper) => [helper.email, helper.phone].filter(Boolean).join(' / ');
const nameOf = (helper: EventHelper) => helper.displayName || 'Erased';

function ContactCell({ helper }: { helper: EventHelper }) {
  return (
    <div className="ev-cell-stack">
      {helper.email && <span>{helper.email}</span>}
      {helper.phone && <span>{helper.phone}</span>}
      {!helper.email && !helper.phone && <span className="ev-secondary">—</span>}
    </div>
  );
}
const LinkedTag = ({ linked }: { linked: boolean }) => (
  <Tag size="sm" type={linked ? 'green' : 'warm-gray'}>
    {linked ? 'Linked' : 'Not linked'}
  </Tag>
);

export function HelpersTab({
  event,
  canAssign,
  canSeeNames,
  canSeeContacts,
}: {
  event: Event;
  canAssign: boolean;
  canSeeNames: boolean;
  canSeeContacts: boolean;
}) {
  const client = useQueryClient();
  const shiftsQuery = useQuery(eventShiftsQueryOptions(event.id));
  const helpersQuery = useQuery(eventHelpersQueryOptions(event.id, canSeeNames));
  const [view, setView] = useState('shift');
  const [gapsOnly, setGapsOnly] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const cancel = useMutation({
    mutationFn: (entry: Entry) =>
      cancelEventAssignment(event.id, entry.shift.assignmentId, { expectedVersion: entry.shift.version }),
    onSuccess: async () => {
      await invalidateEvents(client);
      setDialog(null);
    },
  });
  const closed = isClosed(event.status);
  const assignable = canAssign && !closed;
  const helpers = helpersQuery.data;
  const names = canSeeNames && Boolean(helpers);
  const shifts = (shiftsQuery.data?.items ?? [])
    .filter((shift) => shift.status !== 'cancelled')
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const hasGap = (shift: EventShift) => shift.requirements.some((p) => p.filledCount < p.requiredCount);
  const shown = shifts.filter((shift) => !gapsOnly || hasGap(shift));
  const byRequirement = new Map<string, Entry[]>();
  for (const helper of helpers?.helpers ?? [])
    for (const shift of helper.shifts)
      byRequirement.set(shift.requirementId, [...(byRequirement.get(shift.requirementId) ?? []), { helper, shift }]);
  const required = helpers?.requiredCount ?? event.requiredCount;
  const filled = helpers?.filledCount ?? event.filledCount;
  const unlinked = helpers?.unlinkedSignups ?? [];
  const overridden = new Set(helpers?.overriddenAssignmentIds ?? []);
  const overriddenEntries = (helpers?.helpers ?? []).flatMap((helper) =>
    helper.shifts.filter((s) => overridden.has(s.assignmentId)).map((shift) => ({ helper, shift })),
  );
  const close = () => setDialog(null);

  const openLink = (entry: Entry) =>
    setDialog({
      kind: 'link',
      entry,
      suggestions: unlinked.find((u) => u.assignmentId === entry.shift.assignmentId)?.suggestions ?? [],
    });
  const rowMenu = (entry: Entry) =>
    assignable && (
      <OverflowMenu flipped size="sm" iconDescription={`Actions for ${nameOf(entry.helper)}`}>
        <OverflowMenuItem
          itemText="Move"
          onClick={() =>
            setDialog({
              kind: 'move',
              target: {
                assignmentId: entry.shift.assignmentId,
                version: entry.shift.version,
                shiftId: entry.shift.shiftId,
                requirementId: entry.shift.requirementId,
                name: nameOf(entry.helper),
                contact: contactOf(entry.helper),
              },
            })
          }
        />
        {!entry.helper.personId && <OverflowMenuItem itemText="Link person" onClick={() => openLink(entry)} />}
        <OverflowMenuItem
          itemText="Cancel assignment"
          isDelete
          hasDivider
          onClick={() => setDialog({ kind: 'cancel', entry })}
        />
      </OverflowMenu>
    );

  const shiftSection = (shift: EventShift) => {
    const fill = shift.requirements.reduce((n, p) => n + Math.min(p.requiredCount, p.filledCount), 0);
    const total = shift.requirements.reduce((n, p) => n + p.requiredCount, 0);
    const positions = shift.requirements.filter((p) => !gapsOnly || p.filledCount < p.requiredCount);
    return (
      <section key={shift.id} className="ev-staff-shift" aria-label={shift.name}>
        <SectionHeading
          level={3}
          title={shift.name}
          summary={`${fmtDay(shift.startsAt)}, ${fmtRange(shift.startsAt, shift.endsAt)} · ${fill} of ${total} filled`}
        />
        {shift.requirements.length === 0 ? (
          <p className="ev-secondary">No positions yet. Add them in the Programme tab.</p>
        ) : names ? (
          <div className="ev-scroll">
            <Table size="md" aria-label={`Helpers for ${shift.name}`} className="ev-table ev-table--helpers">
              <TableHead>
                <TableRow>
                  <TableHeader>Position</TableHeader>
                  <TableHeader>Helper</TableHeader>
                  {canSeeContacts && <TableHeader>Contact</TableHeader>}
                  <TableHeader>Source</TableHeader>
                  <TableHeader>Linked</TableHeader>
                  <TableHeader className="ev-col-actions">
                    <span className="cds--visually-hidden">Actions</span>
                  </TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {positions.flatMap((position) => {
                  const entries = byRequirement.get(position.id) ?? [];
                  const open = Math.max(0, position.requiredCount - entries.length);
                  const cell = (
                    <TableCell>
                      <div className="ev-cell-stack">
                        <span>{position.name}</span>
                        {position.eligibilityMode === 'roles' && (
                          <span className="ev-secondary">Members with roles</span>
                        )}
                      </div>
                    </TableCell>
                  );
                  return [
                    ...entries.map((entry) => (
                      <TableRow key={entry.shift.assignmentId}>
                        {cell}
                        <TableCell>
                          <strong>{nameOf(entry.helper)}</strong>
                        </TableCell>
                        {canSeeContacts && (
                          <TableCell>
                            <ContactCell helper={entry.helper} />
                          </TableCell>
                        )}
                        <TableCell>
                          <div className="ev-inline">
                            <Tag size="sm" type={SOURCE[entry.shift.source].type}>
                              {SOURCE[entry.shift.source].label}
                            </Tag>
                            {entry.shift.conflictOverridden && (
                              <Tag size="sm" type="magenta">
                                Conflict overridden
                              </Tag>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <LinkedTag linked={Boolean(entry.helper.personId)} />
                        </TableCell>
                        <TableCell className="ev-col-actions">{rowMenu(entry)}</TableCell>
                      </TableRow>
                    )),
                    ...Array.from({ length: open }, (_, index) => (
                      <TableRow key={`${position.id}-open-${index}`} className="ev-row--open">
                        {cell}
                        <TableCell>
                          <span className="ev-secondary">Open place</span>
                        </TableCell>
                        {canSeeContacts && <TableCell>—</TableCell>}
                        <TableCell>—</TableCell>
                        <TableCell>—</TableCell>
                        <TableCell className="ev-col-actions">
                          {assignable && (
                            <Button
                              kind="ghost"
                              size="sm"
                              renderIcon={UserFollow}
                              onClick={() =>
                                setDialog({ kind: 'assign', shiftId: shift.id, requirementId: position.id })
                              }
                            >
                              Assign
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    )),
                  ];
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="ev-scroll">
            <Table size="md" aria-label={`Places for ${shift.name}`} className="ev-table">
              <TableHead>
                <TableRow>
                  <TableHeader>Position</TableHeader>
                  <TableHeader>Places</TableHeader>
                  <TableHeader>Status</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {positions.map((position) => {
                  const open = Math.max(0, position.requiredCount - position.filledCount);
                  return (
                    <TableRow key={position.id}>
                      <TableCell>{position.name}</TableCell>
                      <TableCell>
                        <FillMeter filled={position.filledCount} required={position.requiredCount} />
                      </TableCell>
                      <TableCell>{open > 0 ? plural(open, 'open place') : 'All places filled'}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    );
  };

  const helperTable = () => {
    const rows = helpers?.helpers ?? [];
    if (rows.length === 0)
      return (
        <EmptyState
          title="No helpers yet"
          description="Assigned and signed-up helpers appear here, one row per person."
        />
      );
    return (
      <div className="ev-scroll">
        <Table size="md" aria-label="Helpers" className="ev-table ev-table--helpers">
          <TableHead>
            <TableRow>
              <TableHeader>Helper</TableHeader>
              {canSeeContacts && <TableHeader>Contact</TableHeader>}
              <TableHeader>Shifts</TableHeader>
              <TableHeader>Source</TableHeader>
              <TableHeader>Linked</TableHeader>
              <TableHeader className="ev-col-actions">
                <span className="cds--visually-hidden">Actions</span>
              </TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((helper) => (
              <TableRow key={helper.key}>
                <TableCell>
                  <strong>{nameOf(helper)}</strong>
                </TableCell>
                {canSeeContacts && (
                  <TableCell>
                    <ContactCell helper={helper} />
                  </TableCell>
                )}
                <TableCell>
                  <div className="ev-cell-stack">
                    {helper.shifts.map((s) => (
                      <span key={s.assignmentId}>
                        {s.shiftName} · {s.requirementName}
                        <span className="ev-secondary">
                          {' '}
                          · {fmtDay(s.startsAt)} {fmtRange(s.startsAt, s.endsAt)}
                        </span>
                      </span>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="ev-inline">
                    {helper.sources.map((source) => (
                      <Tag key={source} size="sm" type={SOURCE[source].type}>
                        {SOURCE[source].label}
                      </Tag>
                    ))}
                    {helper.conflictOverridden && (
                      <Tag size="sm" type="magenta">
                        Conflict overridden
                      </Tag>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <LinkedTag linked={Boolean(helper.personId)} />
                </TableCell>
                <TableCell className="ev-col-actions">
                  {!helper.personId && assignable && canSeeContacts && (
                    <Button kind="ghost" size="sm" onClick={() => openLink({ helper, shift: helper.shifts[0] })}>
                      Link person
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  };

  const showAttention = canSeeContacts && (unlinked.length > 0 || overriddenEntries.length > 0);
  const nameOfAssignment = (id: string) =>
    (helpers?.helpers ?? []).find((h) => h.shifts.some((s) => s.assignmentId === id));
  return (
    <div className="ev-stack ev-tab">
      {closed && <p className="ev-secondary">{closedNotice(event.status)}</p>}
      {!canSeeNames && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Counts only"
          subtitle="Helper names and contact details need the permission to assign or manage staffing."
        />
      )}
      <SummaryTiles
        items={[
          {
            label: 'Places filled',
            value: `${filled} of ${required}`,
            detail: required > 0 ? <FillMeter filled={filled} required={required} /> : undefined,
          },
          { label: 'Open places', value: helpers?.openPlaces ?? event.openPlaces },
          { label: 'Signups to review', value: unlinked.length },
        ]}
      />
      {showAttention && (
        <Tile className="ev-attention">
          <SectionHeading title="Needs attention" summary={String(unlinked.length + overriddenEntries.length)} />
          <ul className="ev-attention__list">
            {unlinked.map((item) => {
              const helper = nameOfAssignment(item.assignmentId);
              const entry = helper && {
                helper,
                shift: helper.shifts.find((s) => s.assignmentId === item.assignmentId)!,
              };
              return (
                <li key={item.assignmentId}>
                  <WarningAltFilled size={16} className="ev-attention__icon ev-attention__icon--warning" />
                  <span className="ev-attention__text">
                    <strong>{item.displayName || 'A helper'}</strong> signed up publicly, not linked to a person.{' '}
                    <span className="ev-secondary">
                      {item.suggestions.length > 0
                        ? `Suggested match: ${item.suggestions.map((p) => `${p.firstName} ${p.lastName}`).join(', ')}.`
                        : 'No match found by email or phone.'}
                    </span>
                  </span>
                  {assignable && entry && (
                    <Button kind="ghost" size="sm" onClick={() => openLink(entry)}>
                      Link person
                    </Button>
                  )}
                </li>
              );
            })}
            {overriddenEntries.map((entry) => (
              <li key={entry.shift.assignmentId}>
                <InformationFilled size={16} className="ev-attention__icon" />
                <span className="ev-attention__text">
                  <strong>{nameOf(entry.helper)}</strong> was placed despite an overlapping shift.{' '}
                  <span className="ev-secondary">The override is in the audit log.</span>
                </span>
              </li>
            ))}
          </ul>
        </Tile>
      )}
      <TabToolbar
        left={
          <>
            {names && (
              <SectionSwitcher
                label="Helper views"
                selected={view}
                sections={[
                  { id: 'shift', label: 'By shift' },
                  { id: 'helper', label: 'By helper' },
                ]}
                onChange={setView}
              />
            )}
            {(view === 'shift' || !names) && (
              <Toggle
                id="ev-gaps-only"
                size="sm"
                labelText="Only gaps"
                labelA="Off"
                labelB="On"
                toggled={gapsOnly}
                onToggle={setGapsOnly}
              />
            )}
          </>
        }
        right={
          assignable &&
          shifts.length > 0 && (
            <Button kind="tertiary" renderIcon={Add} onClick={() => setDialog({ kind: 'assign' })}>
              Assign helper
            </Button>
          )
        }
      />
      {(shiftsQuery.isPending || (canSeeNames && helpersQuery.isPending)) && (
        <InlineLoadingState label="Loading helpers" />
      )}
      {(shiftsQuery.isError || helpersQuery.isError) && (
        <ErrorState
          title="Unable to load helpers"
          message="Check the connection and try again."
          onRetry={() => {
            void shiftsQuery.refetch();
            void helpersQuery.refetch();
          }}
        />
      )}
      {(view === 'shift' || !names) &&
        shiftsQuery.isSuccess &&
        (shown.length === 0 ? (
          <EmptyState
            title={gapsOnly ? 'No gaps' : 'No helper shifts yet'}
            description={
              gapsOnly
                ? 'Every place of every shift is filled.'
                : 'Add shifts with positions in the Programme tab, then fill them here.'
            }
          />
        ) : (
          shown.map(shiftSection)
        ))}
      {view === 'helper' && names && helperTable()}

      {dialog?.kind === 'assign' && (
        <AssignDialog
          eventId={event.id}
          shiftId={dialog.shiftId}
          requirementId={dialog.requirementId}
          onClose={close}
        />
      )}
      {dialog?.kind === 'move' && <AssignDialog eventId={event.id} move={dialog.target} onClose={close} />}
      {dialog?.kind === 'link' && (
        <LinkPersonDialog
          eventId={event.id}
          assignment={{
            id: dialog.entry.shift.assignmentId,
            version: dialog.entry.shift.version,
            name: nameOf(dialog.entry.helper),
            contact: contactOf(dialog.entry.helper),
            suggestions: dialog.suggestions,
          }}
          onClose={close}
        />
      )}
      <DestructiveActionDialog
        open={dialog?.kind === 'cancel'}
        title="Cancel assignment?"
        confirmLabel="Cancel assignment"
        pending={cancel.isPending}
        error={cancel.isError ? eventMutationMessage(cancel.error) : undefined}
        onClose={() => {
          cancel.reset();
          close();
        }}
        onConfirm={() => dialog?.kind === 'cancel' && cancel.mutate(dialog.entry)}
      >
        <p>
          {dialog?.kind === 'cancel' ? nameOf(dialog.entry.helper) : 'The helper'} loses this place and it becomes open
          again. A cancelled assignment cannot be reactivated; assign the person again instead.
        </p>
      </DestructiveActionDialog>
    </div>
  );
}
