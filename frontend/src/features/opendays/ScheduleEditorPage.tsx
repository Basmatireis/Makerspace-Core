import './styles.scss';
import { Button, InlineNotification, Tag } from '@carbon/react';
import { DragDropProvider, type DragEndEvent } from '@dnd-kit/react';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { periodRange, signUpDeadlineLabel, statusTagType } from './format';
import { OpenDayRegistrationModal } from './OpenDayDetailPage';
import { toPreviewOpenDay, actionsForStatus, scheduleErrorMessage } from './schedule/scheduleHelpers';
import { OpenDayPreviewView } from './schedule/OpenDayPreviewView';
import { ScheduleWorkingView } from './schedule/ScheduleWorkingView';
import { BulkEditDialog } from './schedule/BulkEditDialog';
import { CreateOpenDayDialog } from './schedule/CreateOpenDayDialog';
import {
  EditOpenDayDialog,
  LifecycleTransitionDialog,
  MoveContextDialog,
  PublishedSaveDialog,
  RemovalDialog,
} from './schedule/ScheduleConfirmDialogs';
import { useScheduleEditor } from './schedule/useScheduleEditor';

export function ScheduleEditorPage({ canManage = true }: { canManage?: boolean }) {
  const editor = useScheduleEditor({ canManage });
  const {
    periodId,
    scheduleQuery,
    rolesQuery,
    contextQuery,
    state,
    dispatch,
    createOpen,
    timeError,
    setTimeError,
    setEditing,
    bulkEditing,
    pendingRemoval,
    setPendingRemoval,
    setPublishedSaveConfirmation,
    setPendingMove,
    setPendingTransition,
    isPhone,
    hasCoarsePointer,
    view,
    setView,
    dateTimeFilter,
    setDateTimeFilter,
    previewFilter,
    setPreviewFilter,
    selectedOpenDayId,
    setSelectedOpenDayId,
    tableRevision,
    unsavedChanges,
    period,
    editingAllowed,
    editMode,
    showMode,
    beginBulkEdit,
    openCreate,
    saveMutation,
    lifecycleMutation,
  } = editor;

  if (scheduleQuery.isPending || (canManage && rolesQuery.isPending))
    return <InlineLoadingState label="Loading Open Day period" />;
  if (scheduleQuery.isError || (canManage && rolesQuery.isError) || !scheduleQuery.data)
    return (
      <ErrorState
        title="Unable to load this period"
        message="It may no longer be visible, or the connection failed."
        onRetry={() => {
          void scheduleQuery.refetch();
          if (canManage) void rolesQuery.refetch();
        }}
      />
    );

  const schedule = scheduleQuery.data;

  const moveSlot = (id: string, date: string) =>
    dispatch({ type: 'move', id, date, timeZone: scheduleQuery.data.timeZone });
  const lifecycleActions = actionsForStatus(scheduleQuery.data.period.status);
  const previewItems = state.slots.map((slot) => toPreviewOpenDay(slot, periodId));
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.canceled || !event.operation.source?.id || !event.operation.target?.id) return;
    const id = String(event.operation.source.id);
    const date = String(event.operation.target.id);
    const entries = (contextQuery.data?.entries ?? []).filter(
      (entry) => entry.startsOn <= date && entry.endsOn >= date,
    );
    if (entries.length) setPendingMove({ id, date, entries });
    else moveSlot(id, date);
  };

  return (
    <DragDropProvider onDragEnd={handleDragEnd}>
      <PageShell
        title={scheduleQuery.data.period.name}
        titleAdornment={
          <Tag type={statusTagType(scheduleQuery.data.period.status)}>{scheduleQuery.data.period.status}</Tag>
        }
        breadcrumbs={[{ label: 'Open Days', to: '/open-days' }, { label: scheduleQuery.data.period.name }]}
        description={[periodRange(scheduleQuery.data.period), signUpDeadlineLabel(scheduleQuery.data.period)]
          .filter(Boolean)
          .join(' · ')}
        actions={
          editMode
            ? lifecycleActions.map((action) => (
                <Button
                  key={action.target}
                  kind={action.danger ? 'danger--tertiary' : 'tertiary'}
                  disabled={state.dirty || lifecycleMutation.isPending || saveMutation.isPending}
                  onClick={() => setPendingTransition(action)}
                >
                  {action.label}
                </Button>
              ))
            : undefined
        }
        width="wide"
        className="open-day-period-page schedule-editor-page"
      >
        {editMode && saveMutation.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            title="Schedule was not saved"
            subtitle={scheduleErrorMessage(saveMutation.error)}
          />
        )}
        {editMode && lifecycleMutation.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            title="Status change failed"
            subtitle="The period may have changed. Reload and try again."
            onCloseButtonClick={() => lifecycleMutation.reset()}
          />
        )}
        {editMode && ((!createOpen && timeError) || state.error) && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Choose a different local time"
            subtitle={state.error ?? timeError ?? undefined}
          />
        )}
        {contextQuery.isError && (
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title="Calendar context unavailable"
            subtitle="Open Days can still be edited, but holidays and academic breaks are temporarily hidden."
          />
        )}
        {editMode ? (
          <ScheduleWorkingView
            key={tableRevision}
            view={view}
            isPhone={isPhone}
            disableDrag={isPhone || hasCoarsePointer}
            onView={setView}
            dateTimeFilter={dateTimeFilter}
            onDateTimeFilter={setDateTimeFilter}
            slots={state.slots}
            startsOn={scheduleQuery.data.period.startsOn}
            endsOn={scheduleQuery.data.period.endsOn}
            entries={contextQuery.data?.entries ?? []}
            timeZone={scheduleQuery.data.timeZone}
            periodStatus={scheduleQuery.data.period.status}
            dirty={state.dirty}
            canUndo={Boolean(state.previous)}
            lifecyclePending={lifecycleMutation.isPending}
            savePending={saveMutation.isPending}
            onUndo={() => dispatch({ type: 'undo' })}
            onSave={() => (period?.status === 'published' ? setPublishedSaveConfirmation(true) : saveMutation.mutate())}
            onCreate={() => openCreate()}
            onPreview={() => showMode('preview')}
            onAdd={(date) => openCreate('single', date)}
            onEdit={(slot) => {
              setTimeError(null);
              setEditing(slot);
            }}
            onRemove={(slots) => setPendingRemoval(slots)}
            onBulkEdit={beginBulkEdit}
          />
        ) : (
          <OpenDayPreviewView
            filter={previewFilter}
            dateTimeFilter={dateTimeFilter}
            items={previewItems}
            timeZone={scheduleQuery.data.timeZone}
            view={view}
            isPhone={isPhone}
            canEdit={editingAllowed}
            period={scheduleQuery.data.period}
            entries={contextQuery.data?.entries ?? []}
            onFilter={setPreviewFilter}
            onDateTimeFilter={setDateTimeFilter}
            onView={setView}
            onEdit={() => showMode('edit')}
            onOpenDay={(day) => {
              const slot = state.slots.find((item) => item.id === day.id);
              if (slot?.serverId) setSelectedOpenDayId(slot.serverId);
            }}
          />
        )}
        {selectedOpenDayId && !unsavedChanges.dialogOpen && (
          <OpenDayRegistrationModal
            periodId={scheduleQuery.data.period.id}
            periodStatus={scheduleQuery.data.period.status}
            openDayId={selectedOpenDayId}
            onRequestClose={() => setSelectedOpenDayId(null)}
          />
        )}
        {editMode && <LifecycleTransitionDialog editor={editor} />}
        {editMode && createOpen && <CreateOpenDayDialog editor={editor} schedule={schedule} />}
        {editMode && <EditOpenDayDialog editor={editor} schedule={schedule} />}
        {editMode && bulkEditing && <BulkEditDialog editor={editor} bulkEditing={bulkEditing} />}
        {editMode && pendingRemoval && (
          <RemovalDialog editor={editor} schedule={schedule} pendingRemoval={pendingRemoval} />
        )}
        {editMode && <PublishedSaveDialog editor={editor} />}
        {editMode && <MoveContextDialog editor={editor} moveSlot={moveSlot} />}
        <UnsavedChangesDialog
          guard={unsavedChanges}
          title="Discard unsaved schedule changes?"
          message="Your local schedule changes and any open form inputs have not been saved."
        />
      </PageShell>
    </DragDropProvider>
  );
}
