import {
  Button,
  ContainedList,
  ContainedListItem,
  IconButton,
  InlineNotification,
  Stack,
  TextInput,
  Toggle,
} from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { useForm } from 'react-hook-form';
import type { SignageWebEmbed } from '../../api/generated/models';
import { useUpdateEmbed } from './embedMutations';
import { errorMessage, isStaleWrite } from './helpers';
import { canRemoveOrigin, normalizeOrigin, originProblem } from './webEmbeds';

/** The websites that may show the embed, and whether its link also opens on its own. */
export function WebEmbedWebsitesTab({ embed, canManage }: { embed: SignageWebEmbed; canManage: boolean }) {
  const update = useUpdateEmbed(embed.id);
  const form = useForm<{ website: string }>({ defaultValues: { website: '' } });
  const { errors } = form.formState;
  const origins = embed.allowedOrigins;
  const removable = canRemoveOrigin(origins);

  const add = form.handleSubmit(({ website }) => {
    const origin = normalizeOrigin(website);
    if (origin === null) return;
    update.mutate(
      { expectedVersion: embed.version, allowedOrigins: [...origins, origin] },
      { onSuccess: () => form.reset({ website: '' }) },
    );
  });

  return (
    <Stack gap={6} className="sg-tab">
      <div className="sg-stack">
        <h2 className="sg-section-title">Websites that may show this embed</h2>
        <p className="sg-secondary">
          Enter the address of each website, for example https://fachschaft-muster.example. Browsers refuse to show the
          embed on any other site. Every embed needs at least one.
        </p>
      </div>
      <ContainedList label="Allowed websites" kind="on-page" isInset>
        {origins.map((origin) => (
          <ContainedListItem
            key={origin}
            action={
              canManage ? (
                <IconButton
                  label={removable ? `Remove ${origin}` : `Remove ${origin} (the last website cannot be removed)`}
                  kind="ghost"
                  size="sm"
                  disabled={!removable || update.isPending}
                  onClick={() =>
                    update.mutate({
                      expectedVersion: embed.version,
                      allowedOrigins: origins.filter((item) => item !== origin),
                    })
                  }
                >
                  <TrashCan />
                </IconButton>
              ) : undefined
            }
          >
            <span className="sg-mono">{origin}</span>
          </ContainedListItem>
        ))}
      </ContainedList>
      {canManage && (
        <form noValidate onSubmit={(event) => void add(event)} className="sg-stack">
          <div className="sg-inline sg-inline--end">
            <TextInput
              id="embed-add-website"
              labelText="Add website"
              placeholder="https://"
              autoComplete="off"
              spellCheck={false}
              helperText="Scheme and host only, no path. Subdomains need their own entry."
              invalid={Boolean(errors.website)}
              invalidText={errors.website?.message}
              {...form.register('website', { validate: (value) => originProblem(value, origins) ?? true })}
            />
            <Button type="submit" kind="tertiary" size="md" renderIcon={Add} disabled={update.isPending}>
              Add
            </Button>
          </div>
        </form>
      )}
      {canManage && !removable && (
        <p className="sg-secondary">
          The last website cannot be removed. Add the new one first, or turn the embed off.
        </p>
      )}
      {update.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Websites not saved"
          subtitle={
            isStaleWrite(update.error)
              ? 'This web embed was changed somewhere else. It was refreshed; try again.'
              : errorMessage(update.error)
          }
        />
      )}
      <Toggle
        id="embed-open-directly"
        labelText="The link also opens on its own"
        labelA="No"
        labelB="Yes"
        toggled={embed.openDirectly}
        disabled={!canManage || update.isPending}
        onToggle={(checked) => update.mutate({ expectedVersion: embed.version, openDirectly: checked })}
      />
      <p className="sg-secondary">
        Lets people open the embed link in a browser tab, for example for a TV in a partner room. Off: the link only
        works inside an allowed website.
      </p>
    </Stack>
  );
}
