import { useEffect, useRef } from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  Checkbox,
  InlineLoading,
  InlineNotification,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Stack,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFilamentSpool } from '../../../api/generated/filament-spools/filament-spools';
import { mountPrinterSpool } from '../../../api/generated/printing/printing';
import { trayIdentifier, trayIdentityDisplay } from '../components/spoolShared';
import type { Material, PrinterLiveStatusTray, PrinterSlot } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { FuzzyComboBox } from '../../../app/components/FuzzyComboBox';
import { DecimalField } from '../../../app/DecimalField';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { decimalValidator, parseDecimalText } from '../../../app/decimalInput';
import { colorsClearlyDiffer, reportedToMaterialHex } from '../colors';
import { SummaryList } from '../components/SummaryList';
import { filamentArticlesQuery } from '../machinesQueries';
import { machineLogbookKeys } from '../queries';
import { formatQuantity } from '../shared/format';
import { useNotify } from '../shared/toasts';

type Values = {
  materialId: string;
  origin: 'existing_stock' | 'new_acquisition';
  weight: string;
  price: string;
  mount: boolean;
};

const articleText = (material: Material | null) =>
  material
    ? [material.displayId, material.name, material.colorName, material.manufacturer].filter(Boolean).join(' · ')
    : '';

/** The article that best fits what the printer reports: same material type, then the closest colour. */
function suggestArticle(articles: Material[], tray: PrinterLiveStatusTray): Material | undefined {
  const type = (tray.materialType ?? '').split(/[\s-]/)[0].toLowerCase();
  const sameType = type
    ? articles.filter(
        (article) =>
          article.materialTypeName.toLowerCase().startsWith(type) || article.materialTypeCode.toLowerCase() === type,
      )
    : [];
  const reported = tray.colorHex ? reportedToMaterialHex(tray.colorHex) : null;
  return sameType.find((article) => reported && article.colorHex && !colorsClearlyDiffer(article.colorHex, reported));
}

const loose = (material: Material | undefined) => Number(material?.unassignedQuantity ?? 0);

/**
 * Registers the spool the printer reports in a slot as a filament unit of an article, from loose stock or as a new
 * purchase, tags it with the spool identifier the printer read and mounts it in the slot.
 */
export function RegisterSlotSpoolModal({
  machineName,
  slot,
  tray,
  canMount,
  onClose,
}: {
  machineName: string;
  slot: PrinterSlot;
  tray: PrinterLiveStatusTray;
  canMount: boolean;
  onClose: () => void;
}) {
  const identifier = trayIdentifier(tray);
  const identity = trayIdentityDisplay(tray);
  const client = useQueryClient();
  const notify = useNotify();
  const articles = useQuery(filamentArticlesQuery());
  const form = useForm<Values>({
    mode: 'onChange',
    defaultValues: { materialId: '', origin: 'new_acquisition', weight: '1000', price: '', mount: canMount },
  });
  const { control, handleSubmit, watch, setValue, formState } = form;
  const items = articles.data ?? [];
  const chosen = items.find((item) => item.id === watch('materialId'));
  const origin = watch('origin');
  const choose = useLatestCallback((material: Material | null) => {
    setValue('materialId', material?.id ?? '', { shouldValidate: true });
    if (!material) return;
    const size = Number(material.packageSize ?? 1000) || 1000;
    const weight = tray.remainPercent == null ? size : Math.round((size * tray.remainPercent) / 100);
    setValue('weight', String(weight), { shouldValidate: true });
    setValue('origin', loose(material) >= weight ? 'existing_stock' : 'new_acquisition', { shouldValidate: true });
  });
  // Suggests an article once, when the list has loaded.
  const suggested = useRef(false);
  const loaded = articles.data;
  useEffect(() => {
    if (!loaded || suggested.current) return;
    suggested.current = true;
    const suggestion = suggestArticle(loaded, tray);
    if (suggestion) choose(suggestion);
  }, [loaded, tray, choose]);
  const save = useMutation({
    mutationFn: async (values: Values) => {
      const material = items.find((item) => item.id === values.materialId);
      if (!material) throw new Error('article missing');
      const spool = await createFilamentSpool({
        materialId: material.id,
        initialNetWeightG: parseDecimalText(values.weight) ?? '0',
        stockMode: values.origin,
        ...(values.origin === 'new_acquisition'
          ? { totalPrice: Number(parseDecimalText(values.price, { places: 2 }) ?? 0).toFixed(2) }
          : {}),
        occurredAt: new Date().toISOString(),
        expectedInventoryVersion: material.inventoryVersion,
        identifiers: identifier ? [identifier] : undefined,
      });
      if (values.mount && canMount) await mountPrinterSpool(slot.id, { spoolId: spool.id });
      return spool;
    },
    onSuccess: async (spool, values) => {
      notify({
        kind: 'success',
        title: values.mount && canMount ? 'Spool registered and mounted' : 'Spool registered',
        subtitle: `${spool.displayId} · ${slot.inputUnitName} · ${slot.name}`,
      });
      onClose();
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
    },
  });
  const errorCode = save.error instanceof ApiError ? (save.error.data as { code?: string } | undefined)?.code : null;
  const submit = handleSubmit((values) => {
    if (!save.isPending) save.mutate(values);
  });
  return (
    <Modal
      open
      size="md"
      modalLabel={`${machineName} · ${slot.inputUnitName} · ${slot.name}`}
      modalHeading="Register spool"
      aria-label="Register spool"
      primaryButtonText={
        save.isPending ? 'Registering…' : watch('mount') && canMount ? 'Register and mount' : 'Register spool'
      }
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!formState.isValid || !chosen || save.isPending}
      preventCloseOnClickOutside
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
        <Stack gap={5}>
          <SummaryList
            label="What the printer reports"
            items={[
              {
                label: 'Printer reports',
                value: (
                  <span className="mj-inline">
                    <span
                      className="mj-swatch"
                      style={{ backgroundColor: tray.colorHex ? `#${tray.colorHex}` : 'transparent' }}
                      aria-hidden
                    />
                    {tray.subBrand ?? tray.materialType ?? 'Unknown material'}
                    {tray.remainPercent != null && <span className="mj-secondary">· {tray.remainPercent} % left</span>}
                  </span>
                ),
              },
              identity ? { label: identity.label, value: identity.value, mono: true } : null,
            ]}
          />
          {articles.isPending && <InlineLoading description="Loading filament articles" />}
          {articles.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Articles could not be loaded"
              subtitle="Close the dialog and try again."
            />
          )}
          {articles.isSuccess && (
            <FuzzyComboBox<Material>
              id="register-article"
              titleText="Article"
              placeholder="Search by number, name or colour"
              helperText={
                items.length === 0
                  ? 'There is no active filament article yet. Add one under Inventory first.'
                  : 'The filament the spool holds. New articles are added under Inventory.'
              }
              items={items}
              itemToString={articleText}
              selectedItem={chosen ?? null}
              onChange={({ selectedItem }) => choose(selectedItem ?? null)}
            />
          )}
          <Controller
            control={control}
            name="origin"
            render={({ field }) => (
              <RadioButtonGroup
                legendText="Stock origin"
                name="register-origin"
                orientation="vertical"
                valueSelected={field.value}
                onChange={(value) => field.onChange(value)}
              >
                <RadioButton
                  id="register-origin-loose"
                  value="existing_stock"
                  labelText={
                    chosen
                      ? `From loose stock (${formatQuantity(chosen.unassignedQuantity)} g loose)`
                      : 'From loose stock'
                  }
                  disabled={!chosen || loose(chosen) <= 0}
                />
                <RadioButton id="register-origin-purchase" value="new_acquisition" labelText="New purchase" />
              </RadioButtonGroup>
            )}
          />
          <Controller
            control={control}
            name="weight"
            rules={{
              validate: (value) => {
                const valid = decimalValidator({ positive: true })(value);
                if (valid !== true) return valid;
                if (origin === 'existing_stock' && chosen && Number(parseDecimalText(value)) > loose(chosen))
                  return `Only ${formatQuantity(chosen.unassignedQuantity)} g of this article is loose.`;
                return true;
              },
              deps: ['origin'],
            }}
            render={({ field, fieldState }) => (
              <DecimalField
                id="register-weight"
                labelText="Net filament on the spool (g)"
                helperText="Prefilled from the remaining percentage the printer reports."
                value={field.value}
                onChange={field.onChange}
                invalid={Boolean(fieldState.error)}
                invalidText={fieldState.error?.message}
              />
            )}
          />
          {origin === 'new_acquisition' && (
            <Controller
              control={control}
              name="price"
              rules={{ validate: decimalValidator({ places: 2, requiredMessage: 'Enter what the spool cost.' }) }}
              render={({ field, fieldState }) => (
                <DecimalField
                  id="register-price"
                  labelText="Purchase price (€)"
                  helperText="Booked as a purchase on this spool."
                  value={field.value}
                  onChange={field.onChange}
                  invalid={Boolean(fieldState.error)}
                  invalidText={fieldState.error?.message}
                />
              )}
            />
          )}
          {canMount && (
            <Controller
              control={control}
              name="mount"
              render={({ field }) => (
                <Checkbox
                  id="register-mount"
                  labelText={`Mount it in ${slot.inputUnitName} · ${slot.name}`}
                  checked={field.value}
                  onChange={(_event, { checked }) => field.onChange(checked)}
                />
              )}
            />
          )}
          {save.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Spool not registered"
              subtitle={
                errorCode === 'identifier_in_use'
                  ? 'Another spool already carries this RFID tag.'
                  : errorCode === 'version_conflict' || (save.error instanceof ApiError && save.error.status === 409)
                    ? 'The stock of the article changed. Choose the article again and retry.'
                    : 'Check the entries and try again.'
              }
            />
          )}
        </Stack>
      </form>
    </Modal>
  );
}
