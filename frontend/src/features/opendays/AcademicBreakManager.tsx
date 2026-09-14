import { useState } from 'react';
import { Add, Education, Edit, TrashCan } from '@carbon/icons-react';
import {
  Button,
  InlineLoading,
  InlineNotification,
  Modal,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TextInput,
} from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createOpenDayAcademicBreak,
  deleteOpenDayAcademicBreak,
  updateOpenDayAcademicBreak,
} from '../../api/generated/open-days/open-days';
import type { AcademicBreak } from '../../api/generated/models';
import { openDayKeys } from './queries';

type BreakDraft = Pick<AcademicBreak, 'id' | 'name' | 'startsOn' | 'endsOn' | 'version'>;

type Props = {
  periodId: string;
  periodStartsOn: string;
  academicBreaks: AcademicBreak[];
  isPending?: boolean;
  isError?: boolean;
};

export function AcademicBreakManager({ periodId, periodStartsOn, academicBreaks, isPending = false, isError = false }: Props) {
  const queryClient = useQueryClient();
  const [managerOpen, setManagerOpen] = useState(false);
  const [breakDraft, setBreakDraft] = useState<BreakDraft | null>(null);
  const [deleteBreak, setDeleteBreak] = useState<AcademicBreak | null>(null);
  const breakMutation = useMutation({
    mutationFn: (value: BreakDraft) => value.id
      ? updateOpenDayAcademicBreak(value.id, {
          name: value.name,
          startsOn: value.startsOn,
          endsOn: value.endsOn,
          expectedVersion: value.version,
        })
      : createOpenDayAcademicBreak({
          name: value.name,
          startsOn: value.startsOn,
          endsOn: value.endsOn,
        }),
    onSuccess: async () => {
      setBreakDraft(null);
      setManagerOpen(true);
      await queryClient.invalidateQueries({ queryKey: openDayKeys.calendarContext(periodId) });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (value: AcademicBreak) => deleteOpenDayAcademicBreak(value.id, { expectedVersion: value.version }),
    onSuccess: async () => {
      setDeleteBreak(null);
      setManagerOpen(true);
      await queryClient.invalidateQueries({ queryKey: openDayKeys.calendarContext(periodId) });
    },
  });
  const invalidRange = Boolean(breakDraft?.startsOn && breakDraft?.endsOn && breakDraft.startsOn > breakDraft.endsOn);
  const closeEditor = () => {
    setBreakDraft(null);
    setDeleteBreak(null);
    setManagerOpen(true);
  };
  const resetErrors = () => {
    breakMutation.reset();
    deleteMutation.reset();
  };

  return (
    <>
      <Button
        kind="secondary"
        renderIcon={Education}
        onClick={() => {
          resetErrors();
          setManagerOpen(true);
        }}
      >
        Manage academic breaks
      </Button>
      <Modal
        open={managerOpen}
        passiveModal
        modalHeading="Academic breaks"
        onRequestClose={() => setManagerOpen(false)}
      >
        <Stack gap={5}>
          <p>Lecture-free periods are informational. Open Days can still be added on these dates.</p>
          <Button
            renderIcon={Add}
            onClick={() => {
              setManagerOpen(false);
              setBreakDraft({ id: '', name: '', startsOn: periodStartsOn, endsOn: periodStartsOn, version: 0 });
            }}
          >
            Add academic break
          </Button>
          {isPending && <InlineLoading description="Loading academic breaks" />}
          {isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Academic breaks could not be loaded"
              subtitle="Close this dialog and try again."
            />
          )}
          {!isPending && !isError && (
            <TableContainer title="Breaks overlapping this period">
              <Table size="sm">
                <TableHead>
                  <TableRow>
                    <TableHeader>Name</TableHeader>
                    <TableHeader>Start</TableHeader>
                    <TableHeader>End</TableHeader>
                    <TableHeader>Actions</TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {academicBreaks.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>{item.name}</TableCell>
                      <TableCell>{item.startsOn}</TableCell>
                      <TableCell>{item.endsOn}</TableCell>
                      <TableCell>
                        <div className="table-actions">
                          <Button
                            hasIconOnly
                            kind="ghost"
                            size="sm"
                            renderIcon={Edit}
                            iconDescription={`Edit ${item.name}`}
                            onClick={() => {
                              setManagerOpen(false);
                              setBreakDraft(item);
                            }}
                          />
                          <Button
                            hasIconOnly
                            kind="danger--ghost"
                            size="sm"
                            renderIcon={TrashCan}
                            iconDescription={`Delete ${item.name}`}
                            onClick={() => {
                              setManagerOpen(false);
                              setDeleteBreak(item);
                            }}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {academicBreaks.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4}>No academic breaks overlap this period.</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Stack>
      </Modal>
      <Modal
        open={Boolean(breakDraft)}
        modalHeading={breakDraft?.id ? 'Edit academic break' : 'Create academic break'}
        primaryButtonText={breakDraft?.id ? 'Save break' : 'Create break'}
        secondaryButtonText="Back"
        primaryButtonDisabled={breakMutation.isPending || !breakDraft?.name.trim() || !breakDraft.startsOn || !breakDraft.endsOn || invalidRange}
        onRequestClose={closeEditor}
        onRequestSubmit={() => breakDraft && breakMutation.mutate(breakDraft)}
      >
        {breakDraft && (
          <Stack gap={5}>
            {breakMutation.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Academic break was not saved"
                subtitle="Review the dates or reload if the break changed elsewhere."
              />
            )}
            <TextInput id="schedule-break-name" labelText="Name" value={breakDraft.name} onChange={(event) => setBreakDraft({ ...breakDraft, name: event.target.value })} />
            <TextInput id="schedule-break-start" type="date" labelText="Start date" value={breakDraft.startsOn} onChange={(event) => setBreakDraft({ ...breakDraft, startsOn: event.target.value })} />
            <TextInput id="schedule-break-end" type="date" labelText="End date" value={breakDraft.endsOn} invalid={invalidRange} invalidText="End date must be on or after the start date." onChange={(event) => setBreakDraft({ ...breakDraft, endsOn: event.target.value })} />
          </Stack>
        )}
      </Modal>
      <Modal
        open={Boolean(deleteBreak)}
        danger
        modalHeading="Delete academic break?"
        primaryButtonText="Delete break"
        secondaryButtonText="Back"
        primaryButtonDisabled={deleteMutation.isPending}
        onRequestClose={closeEditor}
        onRequestSubmit={() => deleteBreak && deleteMutation.mutate(deleteBreak)}
      >
        {deleteMutation.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Academic break was not deleted"
            subtitle="Reload if the break changed elsewhere."
          />
        )}
        <p>{deleteBreak?.name} will no longer appear as calendar context. Existing Open Days are unchanged.</p>
      </Modal>
    </>
  );
}
