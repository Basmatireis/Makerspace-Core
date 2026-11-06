import { Select, SelectItem, TextArea, TextInput } from '@carbon/react';
import { useRef } from 'react';
import type { NotificationCatalogPlaceholder } from '../../../api/generated/models';

type Props = {
  id: string;
  channel: string;
  title: string;
  body: string;
  placeholders: NotificationCatalogPlaceholder[];
  onTitle: (value: string) => void;
  onBody: (value: string) => void;
};

const titleLabel = (channel: string) => (channel === 'email' ? 'Subject' : channel === 'in_app' ? 'Title' : 'Headline');

/** Title and text of a message; the "Insert a field" select puts a placeholder at the cursor of the last used field. */
export function MessageFields({ id, channel, title, body, placeholders, onTitle, onBody }: Props) {
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastFocused = useRef<'title' | 'body'>('body');

  function insert(key: string) {
    const token = `{${key}}`;
    const target = lastFocused.current === 'title' ? titleRef.current : bodyRef.current;
    const text = lastFocused.current === 'title' ? title : body;
    const commit = lastFocused.current === 'title' ? onTitle : onBody;
    const start = target?.selectionStart ?? text.length;
    const end = target?.selectionEnd ?? text.length;
    commit(text.slice(0, start) + token + text.slice(end));
    const caret = start + token.length;
    setTimeout(() => {
      target?.focus();
      target?.setSelectionRange(caret, caret);
    }, 0);
  }

  return (
    <div className="nc-message">
      <Select
        id={`${id}-insert`}
        labelText="Insert a field"
        size="sm"
        value=""
        onChange={(event) => {
          if (event.target.value) insert(event.target.value);
        }}
      >
        <SelectItem value="" text="Insert a field…" />
        {placeholders.map((placeholder) => (
          <SelectItem
            key={placeholder.key}
            value={placeholder.key}
            text={`{${placeholder.key}} · ${placeholder.label}`}
          />
        ))}
      </Select>
      <TextInput
        id={`${id}-title`}
        ref={titleRef}
        labelText={titleLabel(channel)}
        maxLength={120}
        value={title}
        onFocus={() => (lastFocused.current = 'title')}
        onChange={(event) => onTitle(event.target.value)}
      />
      <TextArea
        id={`${id}-body`}
        ref={bodyRef}
        labelText={channel === 'email' ? 'Text' : 'Message'}
        helperText={
          channel === 'email' ? 'The e-mail uses the branded layout and ends with a button to the details.' : undefined
        }
        rows={channel === 'email' ? 4 : 2}
        maxLength={2000}
        value={body}
        onFocus={() => (lastFocused.current = 'body')}
        onChange={(event) => onBody(event.target.value)}
      />
    </div>
  );
}
