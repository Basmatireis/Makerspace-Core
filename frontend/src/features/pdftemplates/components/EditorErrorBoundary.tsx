import { Button, InlineNotification } from '@carbon/react';
import { Component, type ReactNode } from 'react';
import { recoverUnsaved } from '../editorRecovery';
import type { TemplateDocument } from '../model';

interface Props {
  /** The export being edited: unsaved edits are remembered per export. */
  kind: string;
  /** Renders the editor; `recovered` carries the unsaved edits when the person asked for them back. */
  children: (recovered: TemplateDocument | undefined) => ReactNode;
}
interface State {
  error: Error | null;
  /** Changes with every restart, so the editor mounts fresh. */
  attempt: number;
  recovered: TemplateDocument | undefined;
}

/**
 * Keeps an error inside the editor from taking down the whole application: the page frame stays, the error is shown with
 * its message (so it can be reported), and the editor can be started again, with the unsaved edits if there were any.
 */
export class EditorErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0, recovered: undefined };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // Visible in the browser console for a bug report; nothing is sent anywhere.
    console.error('PDF template editor crashed', error, info.componentStack);
  }

  restart = (withEdits: boolean) =>
    this.setState((s) => ({
      error: null,
      attempt: s.attempt + 1,
      recovered: withEdits ? recoverUnsaved(this.props.kind) : undefined,
    }));

  render() {
    const { error, attempt, recovered } = this.state;
    if (!error) return <div key={attempt}>{this.props.children(recovered)}</div>;
    const edits = recoverUnsaved(this.props.kind);
    return (
      <div className="pdft-crash" role="alert">
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="The template editor stopped working."
          subtitle={`${error.name}: ${error.message}`}
        />
        <p className="pdft-hint">
          The rest of the application is not affected. Saved drafts and published versions are safe
          {edits ? '; your unsaved edits are still held in this tab and can be restored.' : '.'}
        </p>
        <div className="pdft-crash__actions">
          <Button kind="primary" size="md" onClick={() => this.restart(false)}>
            Reload editor
          </Button>
          {edits && (
            <Button kind="tertiary" size="md" onClick={() => this.restart(true)}>
              Reload with my unsaved edits
            </Button>
          )}
        </div>
      </div>
    );
  }
}
