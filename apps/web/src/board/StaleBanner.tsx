import { MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';

/**
 * The honesty check this step's own brief asks for: a card whose command is queued reads
 * as pending (`TaskCard`'s badge, driven by `displayStatus`), and THIS says why a queued
 * command might sit there a while — no desktop Client, which is the only thing that
 * actually applies a command, has synced recently enough for the mirror API to see it (see
 * `ClientPresence`'s own docstring on `@tm/protocol/wire`).
 */
export function StaleBanner({ everSeenClient }: { everSeenClient: boolean }): JSX.Element {
  return (
    <MessageBar intent="warning" layout="singleline">
      <MessageBarBody>
        <MessageBarTitle>
          {everSeenClient ? 'No desktop app has synced recently.' : 'No desktop app has ever synced this account.'}
        </MessageBarTitle>
        {everSeenClient
          ? 'Changes made here are queued and apply the next time it does.'
          : 'Sign in and open the desktop app at least once before editing from here.'}
      </MessageBarBody>
    </MessageBar>
  );
}
