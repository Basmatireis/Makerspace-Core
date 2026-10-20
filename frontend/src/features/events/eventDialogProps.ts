export type DialogProps = {
  eventId: string;
  open?: boolean;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
  onDirtyChange?: (dirty: boolean) => void;
};
