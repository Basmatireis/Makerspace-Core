/* eslint-disable react-refresh/only-export-components -- the fields and their validation belong together */
import { TextArea, TextInput } from '@carbon/react';
import type { UseFormReturn } from 'react-hook-form';

export const MAX_TITLE = 120;
export const MAX_BODY = 2000;

export type MessageFieldValues = { title: string; body: string; link: string };

/** A path inside the application or a web address; the server stores an address without a scheme as https. */
export function linkError(value: string): string | true {
  const link = value.trim();
  if (!link) return true;
  if (/[\s\\]/.test(link)) return 'The link must not contain spaces or backslashes.';
  if (link.startsWith('/')) return !link.startsWith('//') || 'A path starts with a single “/”.';
  if (/^[a-z][a-z0-9+.-]*:/i.test(link) && !link.startsWith('https://')) {
    return 'Web addresses must start with https://.';
  }
  try {
    const host = new URL(link.startsWith('https://') ? link : `https://${link}`).hostname;
    return host.includes('.') || 'Enter a path such as /open-days or a web address such as https://example.org.';
  } catch {
    return 'Enter a path such as /open-days or a web address such as https://example.org.';
  }
}

/** Title, text and link of a message; shared by the dialogs that write and edit one. */
export function MessageFields<T extends MessageFieldValues>({ form: wider }: { form: UseFormReturn<T> }) {
  // A form that carries more fields (the roles) is handed in; only these three are touched here.
  const form = wider as unknown as UseFormReturn<MessageFieldValues>;
  const { errors } = form.formState;
  return (
    <>
      <TextInput
        id="message-title"
        labelText="Title"
        maxCount={MAX_TITLE}
        invalid={Boolean(errors.title)}
        invalidText={errors.title?.message}
        {...form.register('title', {
          validate: (value) => {
            const length = value.trim().length;
            if (length === 0) return 'Enter a title.';
            return length <= MAX_TITLE || `Use at most ${MAX_TITLE} characters.`;
          },
        })}
      />
      <TextArea
        id="message-body"
        labelText="Text"
        rows={5}
        enableCounter
        maxCount={MAX_BODY}
        invalid={Boolean(errors.body)}
        invalidText={errors.body?.message}
        {...form.register('body', {
          validate: (value) => {
            const length = value.trim().length;
            if (length === 0) return 'Enter the text of the message.';
            return length <= MAX_BODY || `Use at most ${MAX_BODY} characters.`;
          },
        })}
      />
      <TextInput
        id="message-link"
        labelText="Link (optional)"
        helperText="A page in the app (/open-days) or a web address (https://…)"
        invalid={Boolean(errors.link)}
        invalidText={errors.link?.message}
        {...form.register('link', { validate: linkError })}
      />
    </>
  );
}
