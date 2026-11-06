import { Checkbox, InlineNotification, Modal, Stack, TextArea, TextInput } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { NotificationCategory } from '../../api/generated/models';
import {
  createNotificationCategory,
  updateNotificationCategory,
} from '../../api/generated/notification-rules/notification-rules';
import { notificationCenterKeys, saveProblem } from './queries';

type Props = {
  /** The category to edit, or null to create one. */
  category: NotificationCategory | null;
  canManage: boolean;
  onClose: () => void;
};

/** Mounted only while open, so every opening starts from the category's current values. */
export function CategoryModal({ category, canManage, onClose }: Props) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(category?.name ?? '');
  const [description, setDescription] = useState(category?.description ?? '');
  const [askAgain, setAskAgain] = useState(false);
  // The service category is the only one without consent; it is fixed so it cannot quietly grow into advertising.
  const fixed = category?.basis === 'required';
  const readOnly = !canManage || fixed;
  const save = useMutation({
    mutationFn: () =>
      category
        ? updateNotificationCategory(category.id, {
            expectedVersion: category.version,
            name: name.trim(),
            description: description.trim(),
            ...(askAgain ? { askAgain: true } : {}),
          })
        : createNotificationCategory({ name: name.trim(), description: description.trim(), basis: 'consent' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: notificationCenterKeys.all });
      onClose();
    },
  });
  const problem = save.isError ? saveProblem(save.error, 'Category') : null;
  return (
    <Modal
      open
      size="sm"
      modalLabel="Message category"
      modalHeading={category ? category.name : 'New category'}
      primaryButtonText={category ? 'Save' : 'Create'}
      secondaryButtonText={readOnly ? 'Close' : 'Cancel'}
      primaryButtonDisabled={readOnly || !name.trim() || save.isPending}
      onRequestClose={onClose}
      onSecondarySubmit={onClose}
      onRequestSubmit={() => save.mutate()}
    >
      <Stack gap={6}>
        {problem && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title={problem.title}
            subtitle={problem.message}
          />
        )}
        <TextInput
          id="category-name"
          labelText="Name"
          maxLength={80}
          disabled={readOnly}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <TextArea
          id="category-description"
          labelText="What people are told"
          maxLength={600}
          rows={3}
          disabled={readOnly}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        {fixed ? (
          <p className="nc-note">
            Service &amp; safety is the only category without consent. It is fixed so it can&apos;t quietly grow into
            advertising.
          </p>
        ) : category ? (
          <Checkbox
            id="category-ask-again"
            labelText="Ask everyone again"
            helperText="Only when the meaning changes. Until they answer, people get nothing from this category."
            disabled={readOnly}
            checked={askAgain}
            onChange={(_event, { checked }) => setAskAgain(checked)}
          />
        ) : (
          <p className="nc-note">
            Needs consent. Everyone is asked once, at their next sign-in or check-in; until then nobody gets anything
            from it.
          </p>
        )}
      </Stack>
    </Modal>
  );
}
