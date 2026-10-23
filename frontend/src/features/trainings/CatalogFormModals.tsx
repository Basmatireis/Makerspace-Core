import { Controller, useForm } from 'react-hook-form';
import { InlineNotification, Modal, MultiSelect, NumberInput, Stack, TextArea, TextInput, Toggle } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CompetencyCategory, MachineType, Training } from '../../api/generated/models';
import {
  createCompetencyCategory,
  createTraining,
  updateCompetencyCategory,
  updateTraining,
} from '../../api/generated/trainings/trainings';
import { ApiError } from '../../api/http-client';
import { trainingKeys } from './queries';

function saveError(error: unknown, exists: string): string {
  if (error instanceof ApiError) {
    if (error.data?.code === 'stale_write') return 'Someone else changed this entry. Close the dialog and try again.';
    if (error.data?.code?.endsWith('_exists')) return exists;
    if (error.status === 422) return 'Check the fields and try again.';
  }
  return 'Check your connection and try again.';
}

type CategoryValues = { name: string; description: string; active: boolean; sortOrder: number };

/** Creates or edits a competency category: the label open days show publicly. */
export function CategoryFormModal({ category, onClose }: { category?: CompetencyCategory; onClose: () => void }) {
  const client = useQueryClient();
  const { control, handleSubmit } = useForm<CategoryValues>({
    defaultValues: {
      name: category?.name ?? '',
      description: category?.description ?? '',
      active: category?.active ?? true,
      sortOrder: category?.sortOrder ?? 0,
    },
  });
  const save = useMutation({
    mutationFn: (values: CategoryValues) => {
      const body = {
        name: values.name.trim(),
        description: values.description.trim() || null,
        active: values.active,
        sortOrder: Number(values.sortOrder),
      };
      return category
        ? updateCompetencyCategory(category.id, { ...body, expectedVersion: category.version })
        : createCompetencyCategory(body);
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: trainingKeys.all }),
        client.invalidateQueries({ queryKey: ['open-days'] }),
        client.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
      onClose();
    },
  });
  const submit = handleSubmit((values) => save.mutate(values));
  return (
    <Modal
      open
      size="sm"
      modalHeading={category ? 'Edit competency' : 'Add competency'}
      primaryButtonText={save.isPending ? 'Saving…' : 'Save'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={save.isPending}
      preventCloseOnClickOutside
      shouldSubmitOnEnter={false}
      onRequestClose={() => {
        if (!save.isPending) onClose();
      }}
      onRequestSubmit={() => void submit()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack gap={6}>
          {save.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Competency not saved"
              subtitle={saveError(save.error, 'A competency with this name already exists.')}
            />
          )}
          <Controller
            control={control}
            name="name"
            rules={{
              validate: (value) => (value.trim() !== '' && value.trim().length <= 120) || 'Enter up to 120 characters.',
            }}
            render={({ field, fieldState }) => (
              <TextInput
                id="competency-name"
                labelText="Public label"
                helperText="Shown on the public calendar and signage, for example “3D printing”."
                invalid={Boolean(fieldState.error)}
                invalidText={fieldState.error?.message}
                {...field}
              />
            )}
          />
          <Controller
            control={control}
            name="description"
            render={({ field }) => (
              <TextArea id="competency-description" labelText="Internal description (optional)" rows={2} {...field} />
            )}
          />
          <Controller
            control={control}
            name="sortOrder"
            render={({ field }) => (
              <NumberInput
                id="competency-sort-order"
                label="Sort order"
                helperText="Lower numbers come first; equal numbers sort by label."
                min={-10000}
                max={10000}
                step={10}
                value={field.value}
                onChange={(_, { value }) => field.onChange(Number(value))}
              />
            )}
          />
          <Controller
            control={control}
            name="active"
            render={({ field }) => (
              <Toggle
                id="competency-active"
                labelText="Active"
                labelA="Inactive: open days no longer show it"
                labelB="Active"
                toggled={field.value}
                onToggle={field.onChange}
              />
            )}
          />
        </Stack>
      </form>
    </Modal>
  );
}

type TrainingValues = {
  name: string;
  description: string;
  active: boolean;
  sortOrder: number;
  competencyIds: string[];
  machineTypeIds: string[];
};

/** Creates or edits a training, the competencies it feeds and the machine types it covers. */
export function TrainingFormModal({
  training,
  categories,
  machineTypes,
  onClose,
}: {
  training?: Training;
  categories: readonly CompetencyCategory[];
  /** Undefined when the person may not read machine types; the links are then kept as they are. */
  machineTypes: readonly MachineType[] | undefined;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const { control, handleSubmit } = useForm<TrainingValues>({
    defaultValues: {
      name: training?.name ?? '',
      description: training?.description ?? '',
      active: training?.active ?? true,
      sortOrder: training?.sortOrder ?? 0,
      competencyIds: training?.competencyIds ?? [],
      machineTypeIds: training?.machineTypeIds ?? [],
    },
  });
  const save = useMutation({
    mutationFn: (values: TrainingValues) => {
      const body = {
        name: values.name.trim(),
        description: values.description.trim() || null,
        active: values.active,
        sortOrder: Number(values.sortOrder),
        competencyIds: values.competencyIds,
        machineTypeIds: values.machineTypeIds,
      };
      return training
        ? updateTraining(training.id, { ...body, expectedVersion: training.version })
        : createTraining(body);
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: trainingKeys.all }),
        client.invalidateQueries({ queryKey: ['open-days'] }),
        client.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
      onClose();
    },
  });
  const submit = handleSubmit((values) => save.mutate(values));
  const categoryItems = categories.filter(
    (category) => category.active || training?.competencyIds.includes(category.id),
  );
  const machineTypeItems = (machineTypes ?? []).filter(
    (type) => type.active || training?.machineTypeIds.includes(type.id),
  );
  return (
    <Modal
      open
      size="md"
      modalHeading={training ? 'Edit training' : 'Add training'}
      primaryButtonText={save.isPending ? 'Saving…' : 'Save'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={save.isPending}
      preventCloseOnClickOutside
      shouldSubmitOnEnter={false}
      onRequestClose={() => {
        if (!save.isPending) onClose();
      }}
      onRequestSubmit={() => void submit()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack gap={6}>
          {save.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Training not saved"
              subtitle={saveError(save.error, 'A training with this name already exists.')}
            />
          )}
          <Controller
            control={control}
            name="name"
            rules={{
              validate: (value) => (value.trim() !== '' && value.trim().length <= 150) || 'Enter up to 150 characters.',
            }}
            render={({ field, fieldState }) => (
              <TextInput
                id="training-name"
                labelText="Name"
                helperText="Internal, for example “Bambu Lab H2D – operation”."
                invalid={Boolean(fieldState.error)}
                invalidText={fieldState.error?.message}
                {...field}
              />
            )}
          />
          <Controller
            control={control}
            name="description"
            render={({ field }) => (
              <TextArea id="training-description" labelText="Description (optional)" rows={2} {...field} />
            )}
          />
          <Controller
            control={control}
            name="competencyIds"
            render={({ field }) => (
              <MultiSelect<CompetencyCategory>
                autoAlign
                id="training-competencies"
                titleText="Competencies"
                helperText="Open days show these when a supervisor with this training is assigned."
                label="Choose competencies"
                items={categoryItems}
                itemToString={(item) => item?.name ?? ''}
                selectedItems={categoryItems.filter((item) => field.value.includes(item.id))}
                onChange={({ selectedItems }) => field.onChange((selectedItems ?? []).map((item) => item.id))}
              />
            )}
          />
          {machineTypes && (
            <Controller
              control={control}
              name="machineTypeIds"
              render={({ field }) => (
                <MultiSelect<MachineType>
                  autoAlign
                  id="training-machine-types"
                  titleText="Machine types (optional)"
                  label="Choose machine types"
                  items={machineTypeItems}
                  itemToString={(item) => item?.name ?? ''}
                  selectedItems={machineTypeItems.filter((item) => field.value.includes(item.id))}
                  onChange={({ selectedItems }) => field.onChange((selectedItems ?? []).map((item) => item.id))}
                />
              )}
            />
          )}
          <Controller
            control={control}
            name="sortOrder"
            render={({ field }) => (
              <NumberInput
                id="training-sort-order"
                label="Sort order"
                min={-10000}
                max={10000}
                step={10}
                value={field.value}
                onChange={(_, { value }) => field.onChange(Number(value))}
              />
            )}
          />
          <Controller
            control={control}
            name="active"
            render={({ field }) => (
              <Toggle
                id="training-active"
                labelText="Active"
                labelA="Inactive: records stay but no longer count for open days"
                labelB="Active"
                toggled={field.value}
                onToggle={field.onChange}
              />
            )}
          />
        </Stack>
      </form>
    </Modal>
  );
}
