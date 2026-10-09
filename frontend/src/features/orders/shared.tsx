import { Controller, useForm } from "react-hook-form";
import {
  Button,
  ComboBox,
  InlineNotification,
  Select,
  SelectItem,
  Stack,
  TextInput,
} from "@carbon/react";
import { useQuery } from "@tanstack/react-query";
import type {
  BillingParty,
  OrderCustomer,
  PaymentInput,
} from "../../api/generated/models";
import { billingPartySearchQuery } from "../machinelogbook/queries";
import { DateTimeInput } from "../../app/DateInput";
import {
  instantToZonedDateTimeValue,
  zonedDateTimeValueToISO,
} from "../../app/dateTime";
import { useId, useState } from "react";

export function FinancialError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <InlineNotification
      kind="error"
      title="Could not save"
      subtitle={
        error instanceof Error
          ? error.message
          : "Reload the record and try again."
      }
      hideCloseButton
    />
  );
}
export function CustomerPicker({
  value,
  customerName,
  onChange,
}: {
  value: OrderCustomer | null;
  customerName?: string | null;
  onChange: (customer: OrderCustomer | null) => void;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<BillingParty | null>(() =>
    value
      ? {
          kind: value.kind,
          id: value.id,
          displayName: customerName || "Current customer",
          pricingGroupAssignmentVersion: 0,
        }
      : null,
  );
  const query = useQuery(billingPartySearchQuery(search));
  return (
    <ComboBox
      id="order-customer"
      titleText="Paying customer (optional for immediate fully paid sales)"
      items={query.data?.items ?? []}
      itemToString={(item) => item?.displayName ?? ""}
      selectedItem={selected}
      onInputChange={setSearch}
      onChange={({ selectedItem }) => {
        setSelected(selectedItem ?? null);
        onChange(
          selectedItem
            ? { kind: selectedItem.kind, id: selectedItem.id }
            : null,
        );
      }}
    />
  );
}
export function PaymentForm({
  defaultAmount,
  external = false,
  pending,
  error,
  onSubmit,
}: {
  defaultAmount: string;
  external?: boolean;
  pending: boolean;
  error: unknown;
  onSubmit: (input: PaymentInput) => void;
}) {
  const formId = useId();
  const form = useForm<{
    method: PaymentInput["method"];
    amount: string;
    occurredAt: string;
    externalSource: string;
    externalReference: string;
  }>({
    defaultValues: {
      method: external ? "external" : "cash",
      amount: defaultAmount,
      occurredAt: instantToZonedDateTimeValue(new Date()),
      externalSource: "",
      externalReference: "",
    },
  });
  const method = form.watch("method");
  return (
    <form
      onSubmit={form.handleSubmit((v) =>
        onSubmit({ ...v, occurredAt: zonedDateTimeValueToISO(v.occurredAt) }),
      )}
    >
      <Stack gap={5}>
        <Select
          id={`${formId}-method`}
          labelText="Payment method"
          {...form.register("method")}
          disabled={external}
        >
          <SelectItem value="cash" text="Cash" />
          <SelectItem value="card" text="Card" />
          {external && (
            <SelectItem value="external" text="Payment confirmed by wiRef" />
          )}
        </Select>
        <TextInput
          id={`${formId}-amount`}
          labelText="Amount (€)"
          {...form.register("amount", {
            required: "Amount is required",
            pattern: {
              value: /^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/,
              message: "Use a decimal amount with at most two places",
            },
          })}
          invalid={!!form.formState.errors.amount}
          invalidText={form.formState.errors.amount?.message}
        />
        <Controller
          control={form.control}
          name="occurredAt"
          rules={{ required: true }}
          render={({ field }) => (
            <DateTimeInput
              id={`${formId}-occurred`}
              labelText="Payment occurred at"
              value={field.value}
              onChange={field.onChange}
            />
          )}
        />
        {method === "card" && (
          <TextInput
            id={`${formId}-source`}
            labelText="Terminal/provider"
            {...form.register("externalSource", {
              required:
                method === "card" ? "Terminal/provider is required" : false,
            })}
            invalid={!!form.formState.errors.externalSource}
            invalidText={form.formState.errors.externalSource?.message}
          />
        )}
        {method !== "cash" && (
          <TextInput
            id={`${formId}-reference`}
            labelText={
              external
                ? "wiRef payment confirmation reference"
                : "Confirmed terminal transaction reference"
            }
            {...form.register("externalReference", {
              required: "Payment confirmation reference is required",
            })}
            invalid={!!form.formState.errors.externalReference}
            invalidText={form.formState.errors.externalReference?.message}
          />
        )}
        {method === "card" && (
          <p>
            Record a payment already confirmed by the terminal. If saving fails,
            retry recording the same transaction; do not charge the card again.
          </p>
        )}
        <FinancialError error={error} />
        <Button type="submit" disabled={pending}>
          {pending ? "Recording…" : "Record payment"}
        </Button>
      </Stack>
    </form>
  );
}
