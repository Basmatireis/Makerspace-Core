import { useEffect } from 'react';
import { Button, InlineNotification, Modal, NumberInput, Select, SelectItem, Stack } from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import type { MasterReauthenticationEntry, PermissionId } from '../../api/generated/models';
import { getMasterReauthenticationPolicy, replaceMasterReauthenticationPolicy } from '../../api/generated/roles/roles';
import { permissionListOptions } from './queries';
import { presentPermission } from './permissionPresentation';

type FormValues = { items: { permissionId: PermissionId | ''; withinMinutes: number }[] };

const policyKey = ['roles', 'master-reauthentication-policy'] as const;

/** Which permissions a master may use only after a fresh strong sign-in. UX gate; the API enforces masters only. */
export function MasterReauthenticationPolicyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const policy = useQuery({
    queryKey: policyKey,
    queryFn: ({ signal }) => getMasterReauthenticationPolicy({ signal }),
    enabled: open,
  });
  const permissions = useQuery({ ...permissionListOptions, enabled: open });
  const form = useForm<FormValues>({ defaultValues: { items: [] } });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'items' });
  const { reset } = form;
  useEffect(() => {
    if (policy.data) reset({ items: policy.data.items });
  }, [policy.data, reset]);

  const save = useMutation({
    mutationFn: (values: FormValues) =>
      replaceMasterReauthenticationPolicy({
        items: values.items.filter((item): item is MasterReauthenticationEntry => item.permissionId !== ''),
      }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(policyKey, saved);
      onClose();
    },
  });

  const options = [...(permissions.data?.items ?? [])].sort((left, right) =>
    presentPermission(left).label.localeCompare(presentPermission(right).label),
  );
  const chosen = form.watch('items').map((item) => item.permissionId);
  return (
    <Modal
      open={open}
      size="md"
      modalHeading="Master sign-in policy"
      primaryButtonText={save.isPending ? 'Saving…' : 'Save policy'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={save.isPending || !policy.data}
      preventCloseOnClickOutside
      onRequestClose={onClose}
      onRequestSubmit={form.handleSubmit((values) => save.mutate(values))}
    >
      <Stack gap={5}>
        <p>
          Masters hold every permission but only with a second factor. The permissions below also need a strong sign-in
          within the given time. Only masters can change this policy.
        </p>
        {(policy.isError || save.isError) && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title={save.isError ? 'Policy not saved' : 'Unable to load the policy'}
            subtitle="Try again. Saving needs a recent strong sign-in."
          />
        )}
        {fields.map((field, index) => (
          <Stack orientation="horizontal" gap={4} key={field.id}>
            <Controller
              control={form.control}
              name={`items.${index}.permissionId`}
              rules={{ required: true }}
              render={({ field: input }) => (
                <Select id={`policy-permission-${index}`} labelText="Permission" {...input}>
                  <SelectItem value="" text="Choose a permission" />
                  {options.map((permission) => (
                    <SelectItem
                      key={permission.id}
                      value={permission.id}
                      text={presentPermission(permission).label}
                      disabled={chosen.includes(permission.id) && chosen[index] !== permission.id}
                    />
                  ))}
                </Select>
              )}
            />
            <Controller
              control={form.control}
              name={`items.${index}.withinMinutes`}
              rules={{ min: 1, max: 1440 }}
              render={({ field: input, fieldState }) => (
                <NumberInput
                  id={`policy-minutes-${index}`}
                  label="Minutes"
                  min={1}
                  max={1440}
                  step={5}
                  value={input.value}
                  invalid={Boolean(fieldState.error)}
                  invalidText="1 to 1440"
                  onChange={(_event, state) => input.onChange(Number(state.value))}
                />
              )}
            />
            <Button
              kind="ghost"
              size="sm"
              hasIconOnly
              renderIcon={TrashCan}
              iconDescription={`Remove entry ${index + 1}`}
              onClick={() => remove(index)}
            />
          </Stack>
        ))}
        <div>
          <Button
            kind="tertiary"
            size="sm"
            renderIcon={Add}
            onClick={() => append({ permissionId: '', withinMinutes: 10 })}
          >
            Add permission
          </Button>
        </div>
      </Stack>
    </Modal>
  );
}
