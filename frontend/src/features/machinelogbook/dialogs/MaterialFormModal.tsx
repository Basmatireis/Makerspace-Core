import { useEffect } from 'react';
import { Controller, FormProvider, useForm } from 'react-hook-form';
import { InlineNotification, Modal, Stack, Toggle } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createMaterial, updateMaterial } from '../../../api/generated/inventory/inventory';
import type { Material, MaterialKind } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { useLatestCallback } from '../../../app/useLatestCallback';
import {
  ArticleFields,
  articleBody,
  articleValuesOf,
  blankArticle,
  type ArticleValues,
} from '../components/ArticleFields';
import { machineLogbookKeys } from '../queries';
import { useNotify } from '../shared/toasts';

type Values = { article: ArticleValues; active: boolean };

/**
 * Describes a new article without stock (buying goes through Receive stock) or edits an existing one. The kind comes
 * from the article, or from `kind` for a new one. `reportedColorHex` is the colour a printer or file reported for the
 * context the dialog was opened from (RRGGBB); it offers a one-click "Use reported color".
 */
export function MaterialFormModal({
  open,
  onClose,
  material,
  kind: requestedKind = 'filament',
  reportedColorHex,
}: {
  open: boolean;
  onClose: () => void;
  material?: Material;
  kind?: MaterialKind;
  reportedColorHex?: string | null;
}) {
  const client = useQueryClient();
  const notify = useNotify();
  const kind = material?.kind ?? requestedKind;
  const hasStock = Boolean(material && Number(material.quantity) > 0);
  const defaults = (): Values => ({
    article: material ? articleValuesOf(material) : blankArticle(kind),
    active: material?.active ?? true,
  });
  const form = useForm<Values>({ defaultValues: defaults() });
  const { control, handleSubmit, reset, setError } = form;

  const save = useMutation({
    mutationFn: (values: Values) => {
      const input = articleBody(values.article, kind);
      return material
        ? updateMaterial(material.id, { ...input, active: values.active, expectedVersion: material.version })
        : createMaterial(input);
    },
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({ kind: 'success', title: material ? 'Article saved' : 'Article added', subtitle: saved.name });
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409 && error.data?.code === 'material_name_conflict')
        setError('article.name', { message: 'An article with this name already exists.' });
    },
  });
  const resetForm = useLatestCallback(() => {
    reset(defaults());
    save.reset();
  });
  useEffect(() => {
    if (open) resetForm();
  }, [open, material?.id, resetForm]);
  const pending = save.isPending;
  const submit = handleSubmit((values) => {
    save.mutate(values);
  });
  const nameConflict = save.error instanceof ApiError && save.error.data?.code === 'material_name_conflict';
  const failure = nameConflict ? null : save.error;

  return (
    <Modal
      open={open}
      size="md"
      modalHeading={material ? 'Edit article' : 'New article'}
      primaryButtonText={pending ? 'Saving…' : material ? 'Save article' : 'Add article'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending}
      preventCloseOnClickOutside
      shouldSubmitOnEnter={false}
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onRequestSubmit={() => {
        void submit();
      }}
    >
      <FormProvider {...form}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          noValidate
        >
          <Stack gap={6}>
            {!material && (
              <p className="mj-secondary">Describes the article only. Use Receive stock to book a purchase.</p>
            )}
            {open && (
              <ArticleFields
                kind={kind}
                idPrefix="article"
                unit={material?.unit}
                keepTypeId={material?.materialTypeId}
                reportedColorHex={reportedColorHex}
                showNotes
                hasStock={hasStock}
              />
            )}
            {material && (
              <Controller
                control={control}
                name="active"
                render={({ field }) => (
                  <Toggle
                    id="article-active"
                    labelText="Active"
                    labelA="Inactive"
                    labelB="Active"
                    toggled={field.value}
                    onToggle={(checked) => field.onChange(checked)}
                  />
                )}
              />
            )}
            {failure && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="The article was not saved"
                subtitle={failure instanceof ApiError ? failure.message : 'Try again.'}
              />
            )}
          </Stack>
        </form>
      </FormProvider>
    </Modal>
  );
}
