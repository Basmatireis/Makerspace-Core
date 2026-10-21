import { useEffect } from 'react';
import { Controller, FormProvider, useForm, useWatch } from 'react-hook-form';
import {
  ActionableNotification,
  Button,
  ComboBox,
  Dropdown,
  InlineNotification,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Stack,
  TextArea,
  TextInput,
} from '@carbon/react';
import { useStableItems } from '../../../app/useStableItems';
import { useMutation, useQuery } from '@tanstack/react-query';
import { receiveInventoryStock } from '../../../api/generated/inventory/inventory';
import type {
  FilamentSpool,
  InventoryReceiptPlacement,
  Material,
  MaterialKind,
  MaterialUnit,
  NewFilamentSpoolIdentifierKind,
  ReceiveInventoryStockRequest,
} from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { dateInAppTimeZone, zonedDateTimeToISO } from '../../../app/dateTime';
import { DateInput } from '../../../app/DateInput';
import { DecimalField } from '../../../app/DecimalField';
import { decimalNumber, decimalText, decimalValidator } from '../../../app/decimalInput';
import { useLatestCallback } from '../../../app/useLatestCallback';
import {
  ArticleFields,
  articleBody,
  blankArticle,
  previewName,
  SuggestionComboBox,
  type WithArticle,
} from '../components/ArticleFields';
import { formatQuantity, toDecimal, toMoney, unitLabel } from '../components/inventoryShared';
import { identifierKinds, needsRefill, spoolNameText } from '../components/spoolShared';
import { allMaterialsQuery, materialTypesQuery, suggestionsQuery } from '../inventoryQueries';
import { machineLogbookPaths } from '../shared/paths';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';
import { allSpoolsQuery, errorCode, spoolErrorMessage, useRefreshInventory } from '../spoolData';

type Placement = 'storage' | 'new_spools' | 'reusable_spool';
type Values = WithArticle & {
  mode: 'existing' | 'new';
  materialId: string;
  packageCount: string;
  packageSize: string;
  totalPrice: string;
  supplier: string;
  date: string;
  reference: string;
  note: string;
  placement: Placement;
  reusableSpoolId: string;
  tare: string;
  spoolLocation: string;
  idKind: NewFilamentSpoolIdentifierKind;
  idValue: string;
};

type ArticleItem = { id: string; label: string; isNew?: boolean };
const NEW_ITEM: ArticleItem = { id: '__new__', label: 'New article…', isNew: true };

const articleLabel = (article: Material) =>
  `${article.name} · ${formatQuantity(article.quantity, article.unit)} in stock`;

const defaultsFor = (kind: MaterialKind, article?: Material): Values => ({
  article: blankArticle(kind),
  mode: 'existing',
  materialId: article?.id ?? '',
  packageCount: '1',
  packageSize: article?.packageSize != null ? decimalText(article.packageSize) : '',
  totalPrice: '',
  supplier: '',
  date: dateInAppTimeZone(new Date()),
  reference: '',
  note: '',
  placement: 'storage',
  reusableSpoolId: '',
  tare: '',
  spoolLocation: '',
  idKind: 'nfc',
  idValue: '',
});

/**
 * Receives stock of an article in one step: pick or describe the article, say how much arrived, what it cost and (for
 * filament) where it goes. Replaces separate forms for material, product, purchase and spool.
 */
export function ReceiveStockModal({
  open,
  onClose,
  kind: requestedKind,
  article: fixedArticle,
}: {
  open: boolean;
  onClose: () => void;
  kind: MaterialKind;
  article?: Material;
}) {
  const can = useCan();
  const notify = useNotify();
  const refresh = useRefreshInventory();
  const kind = fixedArticle?.kind ?? requestedKind;
  const filament = kind === 'filament';
  const canSpools = filament && can('filament_spools.manage');
  const form = useForm<Values>({ defaultValues: defaultsFor(kind, fixedArticle) });
  const {
    control,
    handleSubmit,
    reset,
    setValue,
    setError,
    clearErrors,
    formState: { errors },
  } = form;
  const values = useWatch({ control }) as Values;

  const articles = useQuery({ ...allMaterialsQuery(), enabled: open && !fixedArticle });
  const types = useQuery({ ...materialTypesQuery(), enabled: open });
  const emptySpools = useQuery({
    ...allSpoolsQuery({ kind: 'reusable', lifecycle: 'active' }),
    enabled: open && canSpools,
  });
  const candidates = (articles.data?.items ?? []).filter((item) => item.kind === kind);
  const selectable = candidates.filter((item) => item.active);
  const chosen: Material | undefined =
    fixedArticle ?? (values.mode === 'existing' ? candidates.find((item) => item.id === values.materialId) : undefined);
  const newType = (types.data ?? []).find((item) => item.id === values.article?.materialTypeId);
  const unit: MaterialUnit | undefined = chosen?.unit ?? newType?.unit;
  const suggestions = useQuery({
    ...suggestionsQuery(
      chosen?.materialTypeId ?? (values.mode === 'new' ? values.article?.materialTypeId || undefined : undefined),
    ),
    enabled: open,
  }).data;
  const freeSpools: FilamentSpool[] = (emptySpools.data ?? []).filter(needsRefill);

  const resetForm = useLatestCallback(() => {
    reset(defaultsFor(kind, fixedArticle));
    save.reset();
  });
  useEffect(() => {
    if (open) resetForm();
  }, [open, fixedArticle?.id, kind, resetForm]);
  // A new article's package size is the natural size of what arrives.
  const articlePackage = values.article?.packageSize ?? '';
  useEffect(() => {
    if (values.mode === 'new') setValue('packageSize', articlePackage);
  }, [articlePackage, values.mode, setValue]);

  const count = decimalNumber(values.packageCount, { integer: true }) ?? 0;
  const size = decimalNumber(values.packageSize) ?? 0;
  const total = count * size;
  const today = dateInAppTimeZone(new Date());
  const description = values.mode === 'new' ? previewName(values.article, kind, newType?.name) : '';
  const duplicate =
    values.mode === 'new' && description
      ? candidates.find((item) => item.name.toLowerCase() === description.toLowerCase())
      : undefined;

  const selectArticle = (article: Material) => {
    setValue('mode', 'existing');
    setValue('materialId', article.id);
    setValue('packageSize', article.packageSize != null ? decimalText(article.packageSize) : '');
    clearErrors();
  };

  const save = useMutation({
    mutationFn: (data: Values) => {
      const date = data.date === today ? new Date().toISOString() : zonedDateTimeToISO(data.date, '12:00');
      const single = count === 1;
      const identifiers =
        data.idValue.trim() && (data.placement === 'reusable_spool' || (data.placement === 'new_spools' && single))
          ? [{ kind: data.idKind, value: data.idValue.trim() }]
          : undefined;
      let placement: InventoryReceiptPlacement | undefined;
      if (filament && canSpools && data.placement === 'new_spools') {
        const tare = decimalNumber(data.tare);
        placement = {
          mode: 'new_spools',
          tareWeightG: tare == null ? null : toDecimal(tare),
          storageLocation: data.spoolLocation.trim() || null,
          identifiers,
        };
      } else if (filament && canSpools && data.placement === 'reusable_spool') {
        const spool = freeSpools.find((item) => item.id === data.reusableSpoolId);
        placement = {
          mode: 'reusable_spool',
          reusableSpoolId: data.reusableSpoolId,
          reusableSpoolExpectedVersion: spool?.version,
          identifiers,
        };
      } else if (filament) {
        placement = { mode: 'storage' };
      }
      const body: ReceiveInventoryStockRequest = {
        ...(chosen
          ? { materialId: chosen.id, expectedInventoryVersion: chosen.inventoryVersion }
          : { material: articleBody(data.article, kind) }),
        packageCount: count,
        packageSize: toDecimal(decimalNumber(data.packageSize) ?? 0),
        totalPrice: toMoney(decimalNumber(data.totalPrice, { places: 2 }) ?? 0),
        supplier: data.supplier.trim() || null,
        reference: data.reference.trim() || null,
        note: data.note.trim() || null,
        occurredAt: date,
        ...(placement ? { placement } : {}),
      };
      return receiveInventoryStock(body);
    },
    onError: async (error) => {
      if (errorCode(error) === 'material_name_conflict') {
        const id = (error as ApiError).data?.details as { materialId?: string } | undefined;
        await refresh();
        if (id?.materialId) {
          setValue('mode', 'existing');
          setValue('materialId', id.materialId);
        } else setError('article.name', { message: 'An article with this name already exists.' });
        return;
      }
      void refresh();
    },
  });

  const submit = handleSubmit(async (data) => {
    let result;
    try {
      result = await save.mutateAsync(data);
    } catch {
      return;
    }
    await refresh();
    const spool = result.spools.length === 1 ? result.spools[0] : undefined;
    notify({
      kind: 'success',
      title: 'Stock received',
      subtitle: `${result.material.name}: +${formatQuantity(total, result.material.unit)}${result.spools.length > 0 ? ` on ${result.spools.length === 1 ? spool?.displayId : `${result.spools.length} new spools`}` : ''}.`,
      link: spool
        ? { label: `Open ${spool.displayId}`, to: machineLogbookPaths.spool(spool.id) }
        : { label: 'Open article', to: machineLogbookPaths.material(result.material.id) },
    });
    onClose();
  });

  const pending = save.isPending;
  const conflict = errorCode(save.error) === 'material_name_conflict';
  const failure = save.isError && !conflict ? save.error : null;
  const single = count === 1;
  const items = useStableItems<ArticleItem>([
    NEW_ITEM,
    ...selectable.map((item) => ({ id: item.id, label: articleLabel(item) })),
  ]);
  const selectedItem = values.mode === 'new' ? NEW_ITEM : (items.find((item) => item.id === values.materialId) ?? null);
  const placement = values.placement;

  return (
    <Modal
      open={open}
      size="lg"
      modalHeading="Receive stock"
      primaryButtonText={pending ? 'Saving…' : 'Receive stock'}
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
          <Stack gap={7}>
            {conflict && values.mode === 'existing' && (
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="This article already exists"
                subtitle="It was selected instead of creating a new one. Check the quantity and submit again."
              />
            )}
            {failure && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="The stock was not received"
                subtitle={spoolErrorMessage(failure)}
              />
            )}

            <fieldset className="mj-fieldset">
              <legend className="cds--label">Article</legend>
              <Stack gap={6}>
                {fixedArticle ? (
                  <TextInput
                    id="receive-article-fixed"
                    labelText="Article"
                    readOnly
                    value={articleLabel(fixedArticle)}
                    onChange={() => undefined}
                  />
                ) : (
                  <ComboBox<ArticleItem>
                    id="receive-article"
                    titleText="Article"
                    items={items}
                    itemToString={(item) => item?.label ?? ''}
                    selectedItem={selectedItem}
                    placeholder="Search articles or choose New article…"
                    invalid={Boolean(errors.materialId)}
                    invalidText={errors.materialId?.message}
                    helperText={articles.isError ? 'The articles could not be loaded.' : undefined}
                    shouldFilterItem={({ item, inputValue }) =>
                      Boolean(item?.isNew) ||
                      !inputValue ||
                      inputValue === selectedItem?.label ||
                      (item?.label ?? '').toLowerCase().includes(inputValue.toLowerCase())
                    }
                    onChange={({ selectedItem: next }) => {
                      if (!next) return;
                      if (next.isNew) {
                        setValue('mode', 'new');
                        setValue('materialId', '');
                        setValue('packageSize', values.article?.packageSize ?? '');
                        return;
                      }
                      const found = candidates.find((item) => item.id === next.id);
                      if (found) selectArticle(found);
                    }}
                  />
                )}
                <input
                  type="hidden"
                  {...form.register('materialId', {
                    validate: (value, all) => all.mode === 'new' || Boolean(value) || 'Choose an article.',
                  })}
                />
                {values.mode === 'new' && (
                  <>
                    <ArticleFields kind={kind} idPrefix="receive" />
                    {duplicate && (
                      <ActionableNotification
                        inline
                        kind="warning"
                        lowContrast
                        hideCloseButton
                        title="This article already exists"
                        subtitle={`${duplicate.name} is already in the inventory (${formatQuantity(duplicate.quantity, duplicate.unit)}).`}
                        actionButtonLabel="Use it"
                        onActionButtonClick={() => selectArticle(duplicate)}
                      />
                    )}
                    {!fixedArticle && (
                      <div>
                        <Button
                          kind="ghost"
                          size="sm"
                          onClick={() => {
                            setValue('mode', 'existing');
                            setValue('materialId', '');
                          }}
                        >
                          Choose an existing article instead
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </Stack>
            </fieldset>

            <fieldset className="mj-fieldset">
              <legend className="cds--label">Quantity</legend>
              <Stack gap={5}>
                <div className="mj-form-row">
                  <Controller
                    control={control}
                    name="packageCount"
                    rules={{
                      validate: decimalValidator({
                        integer: true,
                        positive: true,
                        max: 500,
                        requiredMessage: 'Enter the number of packages.',
                      }),
                    }}
                    render={({ field, fieldState }) => (
                      <DecimalField
                        integer
                        id="receive-count"
                        labelText="Packages"
                        value={field.value}
                        onChange={field.onChange}
                        invalid={fieldState.invalid}
                        invalidText={fieldState.error?.message}
                      />
                    )}
                  />
                  <Controller
                    control={control}
                    name="packageSize"
                    rules={{
                      validate: decimalValidator({ positive: true, requiredMessage: 'Enter the size of one package.' }),
                    }}
                    render={({ field, fieldState }) => (
                      <DecimalField
                        id="receive-size"
                        labelText={`Size of one package${unit ? ` in ${unitLabel(unit)}` : ''}`}
                        value={field.value}
                        onChange={field.onChange}
                        invalid={fieldState.invalid}
                        invalidText={fieldState.error?.message}
                      />
                    )}
                  />
                </div>
                <p className="mj-secondary" aria-live="polite">
                  {count > 0 && size > 0
                    ? `Total received: ${count} × ${formatQuantity(size, unit ?? 'g')} = ${formatQuantity(total, unit ?? 'g')}`
                    : 'Packages × size gives the total received.'}
                </p>
              </Stack>
            </fieldset>

            <fieldset className="mj-fieldset">
              <legend className="cds--label">Purchase</legend>
              <Stack gap={5}>
                <div className="mj-form-row">
                  <Controller
                    control={control}
                    name="totalPrice"
                    rules={{
                      validate: decimalValidator({
                        places: 2,
                        requiredMessage: 'Enter the total price, zero or more.',
                      }),
                    }}
                    render={({ field, fieldState }) => (
                      <DecimalField
                        id="receive-price"
                        labelText="Total price in EUR"
                        helperText="For all packages together."
                        value={field.value}
                        onChange={field.onChange}
                        invalid={fieldState.invalid}
                        invalidText={fieldState.error?.message}
                      />
                    )}
                  />
                  <Controller
                    control={control}
                    name="supplier"
                    render={({ field }) => (
                      <SuggestionComboBox
                        id="receive-supplier"
                        titleText="Supplier (optional)"
                        items={suggestions?.suppliers ?? []}
                        value={field.value}
                        onChange={field.onChange}
                      />
                    )}
                  />
                </div>
                <div className="mj-form-row">
                  <Controller
                    control={control}
                    name="date"
                    rules={{
                      validate: (value) =>
                        !value
                          ? 'Enter the purchase date.'
                          : value > today
                            ? 'The date cannot be in the future.'
                            : true,
                    }}
                    render={({ field, fieldState }) => (
                      <DateInput
                        id="receive-date"
                        labelText="Date"
                        value={field.value}
                        onChange={field.onChange}
                        invalid={fieldState.invalid}
                        invalidText={fieldState.error?.message}
                        required
                      />
                    )}
                  />
                  <TextInput
                    id="receive-reference"
                    labelText="Reference (optional)"
                    helperText="Order or invoice number."
                    autoComplete="off"
                    maxLength={200}
                    {...form.register('reference')}
                  />
                </div>
                <TextArea
                  id="receive-note"
                  labelText="Note (optional)"
                  rows={2}
                  maxLength={1000}
                  {...form.register('note')}
                />
              </Stack>
            </fieldset>

            {filament && (
              <fieldset className="mj-fieldset">
                <legend className="cds--label">Where it goes</legend>
                {!canSpools ? (
                  <p className="mj-secondary">
                    The filament goes to storage. Loading it onto spools needs the filament spools permission.
                  </p>
                ) : (
                  <Stack gap={5}>
                    <Controller
                      control={control}
                      name="placement"
                      render={({ field }) => (
                        <RadioButtonGroup
                          legendText="Placement"
                          name="receive-placement"
                          orientation="vertical"
                          valueSelected={field.value}
                          onChange={(value) => field.onChange(value)}
                        >
                          <RadioButton id="receive-placement-storage" value="storage" labelText="In storage" />
                          <RadioButton
                            id="receive-placement-new"
                            value="new_spools"
                            labelText="On new spools (one per package)"
                          />
                          <RadioButton
                            id="receive-placement-reusable"
                            value="reusable_spool"
                            disabled={!single}
                            labelText="Load onto a reusable spool"
                          />
                        </RadioButtonGroup>
                      )}
                    />
                    {placement === 'new_spools' && (
                      <div className="mj-form-row">
                        <Controller
                          control={control}
                          name="tare"
                          rules={{ validate: decimalValidator({ optional: true, positive: true }) }}
                          render={({ field, fieldState }) => (
                            <DecimalField
                              id="receive-tare"
                              labelText="Tare weight per spool in g (optional)"
                              helperText="Empty spool, for weighing."
                              value={field.value}
                              onChange={field.onChange}
                              invalid={fieldState.invalid}
                              invalidText={fieldState.error?.message}
                            />
                          )}
                        />
                        <Controller
                          control={control}
                          name="spoolLocation"
                          render={({ field }) => (
                            <SuggestionComboBox
                              id="receive-spool-location"
                              titleText="Spool storage location (optional)"
                              items={suggestions?.storageLocations ?? []}
                              value={field.value}
                              onChange={field.onChange}
                            />
                          )}
                        />
                      </div>
                    )}
                    {placement === 'reusable_spool' && (
                      <Controller
                        control={control}
                        name="reusableSpoolId"
                        rules={{
                          validate: (value, all) =>
                            all.placement !== 'reusable_spool' || Boolean(value) || 'Choose a spool.',
                        }}
                        render={({ field, fieldState }) => (
                          <Dropdown<FilamentSpool>
                            id="receive-reusable"
                            titleText="Reusable spool"
                            label="Choose an empty spool"
                            items={freeSpools}
                            itemToString={(item) => (item ? spoolNameText(item) : '')}
                            selectedItem={freeSpools.find((item) => item.id === field.value)}
                            onChange={({ selectedItem }) => field.onChange(selectedItem?.id ?? '')}
                            helperText={
                              emptySpools.isSuccess && freeSpools.length === 0
                                ? 'No empty reusable spool is available.'
                                : 'Empty, active reusable spools only.'
                            }
                            invalid={fieldState.invalid}
                            invalidText={fieldState.error?.message}
                          />
                        )}
                      />
                    )}
                    {((placement === 'new_spools' && single) || placement === 'reusable_spool') && (
                      <div className="mj-form-row">
                        <Select
                          id="receive-id-kind"
                          labelText="Identifier kind (optional)"
                          {...form.register('idKind')}
                        >
                          {identifierKinds.map((item) => (
                            <SelectItem key={item.id} value={item.id} text={item.label} />
                          ))}
                        </Select>
                        <TextInput
                          id="receive-id-value"
                          labelText="Identifier value (optional)"
                          helperText="As printed or read by the scanner."
                          autoComplete="off"
                          {...form.register('idValue')}
                        />
                      </div>
                    )}
                  </Stack>
                )}
              </fieldset>
            )}
          </Stack>
        </form>
      </FormProvider>
    </Modal>
  );
}
