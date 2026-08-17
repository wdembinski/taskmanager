import { MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import type { ClientPresence } from '@tm/protocol/wire';
import { describeClient, type VersionSkew } from './targetClient';

/**
 * The warning that gets in front of `ipcRegistry`'s refusal.
 *
 * A desktop older than this tab answers a channel it has never heard of with `"<channel>" is
 * not wired up in this build of the desktop app. It is probably older than the browser tab
 * talking to it — update it and try again.` That sentence is correct and it arrives at
 * exactly the wrong moment: after a click, on one control, with no way to tell whether the
 * next control will work either. Both ends have been exchanging `PROTOCOL_VERSION` since it
 * existed, so the mismatch is knowable the moment the board loads — this says it there.
 *
 * Deliberately NOT a blocker. Most channels work across a version gap (that is the whole
 * reason the bump rule is "only when an older peer would be WRONG to ignore it"), and
 * disabling a board because two numbers differ would take away far more than the skew does.
 */
export function SkewBanner({
  skew,
  client,
}: {
  skew: VersionSkew;
  client: ClientPresence;
}): JSX.Element {
  const name = describeClient(client);
  const version = client.info?.appVersion;

  return (
    <MessageBar intent="warning" layout="singleline">
      <MessageBarBody>
        <MessageBarTitle>
          {skew === 'desktop-older'
            ? `${name} is running an older version of the app.`
            : `${name} is running a newer version of the app.`}
        </MessageBarTitle>
        {skew === 'desktop-older'
          ? `Some actions here will be refused until it is updated${version ? ` from v${version}` : ''}.`
          : 'Reload this page to catch up with it.'}
      </MessageBarBody>
    </MessageBar>
  );
}
