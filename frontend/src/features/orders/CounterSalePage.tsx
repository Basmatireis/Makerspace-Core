import {
  Button,
  Checkbox,
  ComboBox,
  InlineNotification,
  Select,
  SelectItem,
  Stack,
  TextInput,
  Tile,
} from "@carbon/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  completeCounterSale,
  previewCounterSale,
} from "../../api/generated/orders/orders";
import type {
  CounterSaleCommand,
  MachineJobOutcome,
  Operator,
} from "../../api/generated/models";
import {
  reviewQuery,
  machinesQuery,
  materialsQuery,
  pricingQuery,
  operatorSearchQuery,
} from "../machinelogbook/queries";
import { useCurrentUser } from "../auth/auth";
import { hasPermission, PermissionId } from "../auth/permissions";
import { PageShell } from "../../app/PageShell";
import { DateTimeInput } from "../../app/DateInput";
import {
  instantToZonedDateTimeValue,
  zonedDateTimeValueToISO,
  isZonedDateTimeValue,
} from "../../app/dateTime";
import { FinancialError } from "./shared";
import { financeKeys, useOperationKeys } from "./operations";

type Fields = {
  source: "manual" | "review";
  machineId: string;
  existingJobId: string;
  operatorPersonId: string;
  outcome: MachineJobOutcome;
  pricingGroupId: string;
  startsAt: string;
  endsAt: string;
  immediate: boolean;
  method: "cash" | "card";
  amount: string;
  externalSource: string;
  externalReference: string;
  usages: { materialId: string; quantity: string }[];
};
export function CounterSalePage() {
  const user = useCurrentUser();
  const [params] = useSearchParams();
  const client = useQueryClient();
  const navigate = useNavigate();
  const key = useOperationKeys();
  const [operatorSearch, setOperatorSearch] = useState("");
  const [selectedOperator, setSelectedOperator] = useState<Operator | null>(
    null,
  );
  const [occurredAt] = useState(() => new Date().toISOString());
  const form = useForm<Fields>({
    defaultValues: {
      source: params.get("job") ? "review" : "manual",
      machineId: "",
      existingJobId: params.get("job") || "",
      operatorPersonId: user.person.id,
      outcome: "successful",
      pricingGroupId: "",
      startsAt: instantToZonedDateTimeValue(new Date(Date.now() - 3600000)),
      endsAt: instantToZonedDateTimeValue(new Date()),
      immediate: false,
      method: "cash",
      amount: "",
      externalSource: "",
      externalReference: "",
      usages: [],
    },
  });
  const usages = useFieldArray({ control: form.control, name: "usages" });
  const source = form.watch("source");
  const method = form.watch("method");
  const machines = useQuery({
    ...machinesQuery({ page: 1, pageSize: 100 }),
    enabled: hasPermission(user, PermissionId.machinesread),
  });
  const materials = useQuery({
    ...materialsQuery({ page: 1, pageSize: 100 }),
    enabled: hasPermission(user, PermissionId.inventoryread),
  });
  const pricing = useQuery({
    ...pricingQuery(),
    enabled: hasPermission(user, PermissionId.pricingread),
  });
  const review = useQuery({
    ...reviewQuery(),
    enabled: hasPermission(user, PermissionId.machine_jobsreview),
  });
  const operators = useQuery(operatorSearchQuery(operatorSearch));
  const jobInput = (v: Fields): CounterSaleCommand["job"] => {
    const job = review.data?.items.find((j) => j.id === v.existingJobId);
    return v.source === "manual"
      ? {
          manualJob: {
            machineId: v.machineId,
            startsAt: zonedDateTimeValueToISO(v.startsAt),
            endsAt: zonedDateTimeValueToISO(v.endsAt),
            operatorPersonId: v.operatorPersonId,
            outcome: v.outcome,
            pricingGroupId: v.pricingGroupId || undefined,
            usages: v.usages,
          },
        }
      : {
          existingJobId: v.existingJobId,
          expectedJobVersion: job?.version,
          operatorPersonId: v.operatorPersonId,
          outcome: v.outcome,
          pricingGroupId: v.pricingGroupId || undefined,
        };
  };
  const [quote, setQuote] = useState<{ fingerprint: string; amount: string }>();
  const values = form.watch();
  const jobFingerprint = (v: Fields) =>
    JSON.stringify([
      v.source,
      v.machineId,
      v.existingJobId,
      review.data?.items.find((j) => j.id === v.existingJobId)?.version,
      v.operatorPersonId,
      v.outcome,
      v.pricingGroupId,
      v.startsAt,
      v.endsAt,
      v.usages,
    ]);
  const fingerprint = jobFingerprint(values);
  const quoteCurrent = quote?.fingerprint === fingerprint;
  const preview = useMutation({
    mutationFn: () => {
      const v = form.getValues();
      const job = jobInput(v);
      const input = { immediateFulfillmentConfirmed: true, job, payments: [] };
      return previewCounterSale({
        ...input,
        operationKey: key("counter-preview", input),
      }).then((result) => ({
        fingerprint: jobFingerprint(v),
        amount: result.totalAmount,
      }));
    },
    onSuccess: (result) => {
      setQuote(result);
      form.setValue("amount", result.amount);
    },
  });
  const mutation = useMutation({
    mutationFn: (v: Fields) => {
      const input: Omit<CounterSaleCommand, "operationKey"> = {
        immediateFulfillmentConfirmed: v.immediate,
        job: jobInput(v),
        payments:
          v.amount === "0" || v.amount === "0.00"
            ? []
            : [
                {
                  method: v.method,
                  amount: v.amount,
                  occurredAt,
                  externalSource: v.externalSource,
                  externalReference: v.externalReference,
                },
              ],
      };
      return completeCounterSale({
        ...input,
        operationKey: key("counter-sale", input),
      });
    },
    onSuccess: async (o) => {
      await client.invalidateQueries({ queryKey: financeKeys });
      await client.invalidateQueries({ queryKey: ["machine-logbook"] });
      navigate(`/orders/${o.id}`);
    },
  });
  const errors = form.formState.errors;
  return (
    <PageShell
      title="Immediate counter sale"
      description="Anonymous sale: confirm the job, capture pricing, finalize the Order, and record full payment together."
      breadcrumbs={[
        { label: "Orders", to: "/orders" },
        { label: "Counter sale" },
      ]}
    >
      <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))}>
        <Stack gap={6}>
          <Tile>
            <Stack gap={5}>
              <Select
                id="sale-source"
                labelText="Job source"
                {...form.register("source")}
              >
                <SelectItem value="manual" text="New manual Machine Job" />
                <SelectItem
                  value="review"
                  text="Confirm an imported review job"
                />
              </Select>
              {source === "manual" ? (
                <>
                  <Select
                    id="sale-machine"
                    labelText="Machine"
                    {...form.register("machineId", {
                      required: source === "manual",
                    })}
                  >
                    <SelectItem value="" text="Select machine" />
                    {machines.data?.items.map((m) => (
                      <SelectItem key={m.id} value={m.id} text={m.name} />
                    ))}
                  </Select>
                  {(["startsAt", "endsAt"] as const).map((n) => (
                    <Controller
                      key={n}
                      name={n}
                      control={form.control}
                      rules={{ validate: isZonedDateTimeValue }}
                      render={({ field }) => (
                        <DateTimeInput
                          id={"sale-" + n}
                          labelText={
                            n === "startsAt" ? "Job starts at" : "Job ends at"
                          }
                          value={field.value}
                          onChange={field.onChange}
                        />
                      )}
                    />
                  ))}
                </>
              ) : (
                <Select
                  id="sale-review-job"
                  labelText="Imported job"
                  {...form.register("existingJobId", {
                    required: source === "review",
                  })}
                >
                  <SelectItem value="" text="Select review job" />
                  {review.data?.items.map((j) => (
                    <SelectItem
                      key={j.id}
                      value={j.id}
                      text={`${j.displayId} · ${j.machine.name}`}
                    />
                  ))}
                </Select>
              )}
              <ComboBox
                id="sale-operator"
                titleText="Operator (defaults to you)"
                items={operators.data?.items ?? []}
                selectedItem={selectedOperator}
                itemToString={(p) => p?.displayName || ""}
                onInputChange={setOperatorSearch}
                onChange={({ selectedItem }) => {
                  setSelectedOperator(selectedItem ?? null);
                  form.setValue(
                    "operatorPersonId",
                    selectedItem?.personId || user.person.id,
                  );
                }}
              />
              <Select
                id="sale-outcome"
                labelText="Outcome"
                {...form.register("outcome")}
              >
                {[
                  "successful",
                  "partial_failure",
                  "failed",
                  "cancelled",
                  "unknown",
                ].map((v) => (
                  <SelectItem key={v} value={v} text={v} />
                ))}
              </Select>
              <Select
                id="sale-pricing-group"
                labelText="Pricing group"
                {...form.register("pricingGroupId")}
              >
                <SelectItem value="" text="Use active global default" />
                {pricing.data?.items
                  .filter((p) => p.active)
                  .map((p) => (
                    <SelectItem key={p.id} value={p.id} text={p.name} />
                  ))}
              </Select>
              <p>
                Customer identity is separate from operator identity and
                pricing. No Person record is created.
              </p>
              {source === "manual" && (
                <>
                  <h3>Material usage</h3>
                  {usages.fields.map((f, index) => (
                    <Stack key={f.id} gap={4}>
                      <Select
                        id={"sale-material-" + index}
                        labelText="Material"
                        {...form.register(`usages.${index}.materialId`, {
                          required: true,
                        })}
                      >
                        <SelectItem value="" text="Select material" />
                        {materials.data?.items.map((m) => (
                          <SelectItem
                            key={m.id}
                            value={m.id}
                            text={`${m.name} (${m.unit})`}
                          />
                        ))}
                      </Select>
                      <TextInput
                        id={"sale-quantity-" + index}
                        labelText="Consumed quantity"
                        {...form.register(`usages.${index}.quantity`, {
                          required: true,
                        })}
                      />
                      <Button
                        kind="danger--tertiary"
                        onClick={() => usages.remove(index)}
                      >
                        Remove material
                      </Button>
                    </Stack>
                  ))}
                  <Button
                    kind="tertiary"
                    onClick={() =>
                      usages.append({ materialId: "", quantity: "" })
                    }
                  >
                    Add material usage
                  </Button>
                </>
              )}
              <Button
                kind="secondary"
                disabled={preview.isPending || mutation.isPending}
                onClick={() => preview.mutate()}
              >
                Review calculated charge
              </Button>
              <FinancialError error={preview.error} />
              {quoteCurrent && (
                <p role="status">Calculated total: € {quote.amount}</p>
              )}
              {quote && !quoteCurrent && (
                <p>
                  Job details changed. Review the charge again before collecting
                  payment.
                </p>
              )}
            </Stack>
          </Tile>
          <Tile>
            <Stack gap={5}>
              <h2>Confirmed payment</h2>
              <Select
                id="sale-payment-method"
                labelText="Payment method"
                {...form.register("method")}
              >
                <SelectItem value="cash" text="Cash" />
                <SelectItem value="card" text="Card" />
              </Select>
              <TextInput
                id="sale-payment-amount"
                labelText="Full amount received (€)"
                {...form.register("amount", {
                  required: "Enter the full amount",
                  pattern: {
                    value: /^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/,
                    message: "Use a decimal amount",
                  },
                })}
                invalid={!!errors.amount}
                invalidText={errors.amount?.message}
              />
              <p>
                The backend calculates the agreed charge and rejects a payment
                that does not settle it fully. A free sale uses 0.
              </p>
              {method === "card" && (
                <>
                  <TextInput
                    id="sale-terminal"
                    labelText="Terminal/provider"
                    {...form.register("externalSource", {
                      required:
                        method === "card"
                          ? "Terminal/provider is required"
                          : false,
                    })}
                    invalid={!!errors.externalSource}
                    invalidText={errors.externalSource?.message}
                  />
                  <TextInput
                    id="sale-terminal-reference"
                    labelText="Confirmed terminal transaction reference"
                    {...form.register("externalReference", {
                      required:
                        method === "card"
                          ? "Transaction reference is required"
                          : false,
                    })}
                    invalid={!!errors.externalReference}
                    invalidText={errors.externalReference?.message}
                  />
                  <InlineNotification
                    kind="info"
                    title="Record an externally confirmed payment"
                    subtitle="A database error cannot undo a terminal payment. Retry recording the same transaction; do not charge the card again."
                    hideCloseButton
                  />
                </>
              )}
              <Controller
                name="immediate"
                control={form.control}
                rules={{
                  validate: (v) =>
                    v || "Immediate fulfillment must be confirmed",
                }}
                render={({ field }) => (
                  <Checkbox
                    id="sale-immediate"
                    labelText="Service is fulfilled now; no later pickup or follow-up is required"
                    checked={field.value}
                    onChange={(_, v) => field.onChange(v.checked)}
                  />
                )}
              />
              {errors.immediate && (
                <p role="alert">{errors.immediate.message}</p>
              )}
              <FinancialError error={mutation.error} />
              <Button
                type="submit"
                disabled={mutation.isPending || !quoteCurrent}
              >
                {mutation.isPending ? "Saving…" : "Complete counter sale"}
              </Button>
            </Stack>
          </Tile>
        </Stack>
      </form>
    </PageShell>
  );
}
