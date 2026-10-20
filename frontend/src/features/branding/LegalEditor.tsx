import { RadioButton, RadioButtonGroup, Stack, TextArea, TextInput, Tile } from '@carbon/react';
import { useForm } from 'react-hook-form';
import ReactMarkdown from 'react-markdown';
import type { LegalConfiguration } from '../../api/generated/models';
import { FormValues } from './brandingSettings';

export function LegalEditor({
  kind,
  register,
  mode,
  markdown,
  setMode,
}: {
  kind: 'imprint' | 'privacy';
  register: ReturnType<typeof useForm<FormValues>>['register'];
  mode: LegalConfiguration['mode'];
  markdown: string;
  setMode?: (mode: LegalConfiguration['mode']) => void;
}) {
  const label = kind === 'imprint' ? 'Imprint' : 'Privacy policy';
  return (
    <Tile className="branding-legal-editor">
      <Stack gap={5}>
        <h2>{label}</h2>
        <RadioButtonGroup
          legendText={`${label} delivery`}
          name={`${kind}-mode`}
          valueSelected={mode}
          orientation="vertical"
          onChange={(value) => setMode?.(value as LegalConfiguration['mode'])}
        >
          <RadioButton labelText="Internal Markdown page" value="internal" id={`${kind}-internal`} />
          <RadioButton labelText="External website" value="external" id={`${kind}-external`} />
        </RadioButtonGroup>
        {mode === 'internal' ? (
          <>
            <TextArea
              id={`${kind}-markdown`}
              labelText="Markdown"
              helperText="Plain Markdown only; raw HTML is not rendered. Maximum 100 KiB."
              rows={12}
              {...register(`${kind}.markdown`, {
                validate: (value) => new TextEncoder().encode(value).byteLength <= 102400 || 'Use at most 100 KiB.',
              })}
            />
            <div className="branding-markdown-preview">
              <h3>Preview</h3>
              {markdown ? (
                <ReactMarkdown
                  components={{
                    a: ({ node, ...props }) => {
                      void node;
                      return <a {...props} target="_blank" rel="noopener noreferrer" />;
                    },
                  }}
                >
                  {markdown}
                </ReactMarkdown>
              ) : (
                <p>No content configured.</p>
              )}
            </div>
          </>
        ) : (
          <TextInput
            id={`${kind}-url`}
            type="url"
            labelText="External URL"
            helperText="Absolute HTTP(S) URL. The server never fetches this address."
            {...register(`${kind}.externalUrl`, {
              validate: (value) => {
                if (!value) return 'Enter an external URL.';
                try {
                  const parsed = new URL(value);
                  return (
                    (['http:', 'https:'].includes(parsed.protocol) &&
                      Boolean(parsed.host) &&
                      !parsed.username &&
                      !parsed.password) ||
                    'Use an absolute HTTP(S) URL without credentials.'
                  );
                } catch {
                  return 'Use an absolute HTTP(S) URL.';
                }
              },
            })}
          />
        )}
      </Stack>
    </Tile>
  );
}
