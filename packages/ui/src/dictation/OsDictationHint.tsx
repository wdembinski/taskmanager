/**
 * The mic hint for an `os-dictation` path (F9.10): a small, subtle button next to a
 * composer's other actions. Nothing here can trigger the OS shortcut itself — there is no
 * API for that — so the click instead focuses the field the shortcut needs focused, and the
 * tooltip is what actually tells you the key. Monochrome and not a toggle: per the board's
 * colour budget, colour is for things that MOVE, and this never does.
 */
import { Button, Tooltip } from '@fluentui/react-components';
import { MicRegular } from '@fluentui/react-icons';
import { osDictationHint, type OsDictationPlatform } from './dictationModel';

export interface OsDictationHintProps {
  platform: OsDictationPlatform;
  /** Focus the field the OS shortcut dictates into — the one thing a click here can do. */
  onFocusField: () => void;
  disabled?: boolean;
}

export function OsDictationHint({
  platform,
  onFocusField,
  disabled = false,
}: OsDictationHintProps): JSX.Element {
  const { tooltip } = osDictationHint(platform);

  return (
    <Tooltip relationship="label" content={tooltip}>
      <Button
        size="small"
        appearance="subtle"
        icon={<MicRegular />}
        aria-label={tooltip}
        disabled={disabled}
        onClick={onFocusField}
      />
    </Tooltip>
  );
}
