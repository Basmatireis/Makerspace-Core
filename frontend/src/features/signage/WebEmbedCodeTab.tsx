import { useState } from 'react';
import {
  Button,
  CodeSnippet,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  Tile,
} from '@carbon/react';
import type { SignageWebEmbed } from '../../api/generated/models';
import { aspectLabel, formatDateTime } from './helpers';
import { RotateKeyDialog } from './WebEmbedDialogs';
import { embedSnippet, hostOf } from './webEmbeds';

/** The iframe to paste into a website, the embed link, and the way to make a new link. */
export function WebEmbedCodeTab({ embed, canManage }: { embed: SignageWebEmbed; canManage: boolean }) {
  const [rotating, setRotating] = useState(false);
  return (
    <div className="sg-stack sg-tab">
      <Tile>
        <div className="sg-stack">
          <h2 className="sg-section-title">Embed code</h2>
          <CodeSnippet type="multi" feedback="Copied" copyButtonDescription="Copy code" wrapText>
            {embedSnippet(embed)}
          </CodeSnippet>
          <p className="sg-secondary">
            Paste it into the website's HTML. The embed fills the width and keeps {aspectLabel(embed.aspectRatio)}. It
            sets no cookies and does not track visitors.
          </p>
        </div>
      </Tile>
      <Tile>
        <div className="sg-stack">
          <h2 className="sg-section-title">Link</h2>
          <StructuredListWrapper isCondensed aria-label="Embed link">
            <StructuredListBody>
              <StructuredListRow>
                <StructuredListCell noWrap>Embed link</StructuredListCell>
                <StructuredListCell className="sg-mono">{embed.embedUrl}</StructuredListCell>
              </StructuredListRow>
              <StructuredListRow>
                <StructuredListCell noWrap>Works on</StructuredListCell>
                <StructuredListCell>
                  {embed.allowedOrigins.map(hostOf).join(', ')}
                  {embed.openDirectly ? ' and on its own' : ''}
                </StructuredListCell>
              </StructuredListRow>
              <StructuredListRow>
                <StructuredListCell noWrap>Created</StructuredListCell>
                <StructuredListCell>{formatDateTime(embed.createdAt)}</StructuredListCell>
              </StructuredListRow>
            </StructuredListBody>
          </StructuredListWrapper>
          {canManage && (
            <>
              <p className="sg-secondary">
                If the code was copied somewhere it should not be, make a new link. The old one stops working at once;
                allowed websites must update their code.
              </p>
              <div>
                <Button kind="danger--tertiary" size="md" onClick={() => setRotating(true)}>
                  Make a new link
                </Button>
              </div>
            </>
          )}
        </div>
      </Tile>
      {rotating && <RotateKeyDialog embed={embed} onClose={() => setRotating(false)} />}
    </div>
  );
}
