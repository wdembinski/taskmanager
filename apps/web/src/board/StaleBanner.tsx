import { MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';

/**
 * The honesty check this step's own brief asks for: a card whose command is queued reads
 * as pending (`TaskCard`'s badge, driven by `displayStatus`), and THIS says why a queued
 * command might sit there a while — no desktop Client, which is the only thing that
 * actually applies a command, has synced recently enough for the mirror API to see it (see
 * `ClientPresence`'s own docstring on `@tm/protocol/wire`).
 *
 * The second sentence names the fix, and it is on the OTHER machine. "Open the desktop app",
 * which is what this used to say, is the one instruction that does not work: the app being
 * open is not what makes it visible here — `POST /v1/sync` is, and that only happens with
 * cloud sync switched on, a vipper.iam sign-in on that machine, and an account allowed to
 * write. All three fail silently over there (the poller counts a failed tick and retries),
 * so the useful thing to say is where the answer lives: Settings → Cloud → Test connection
 * on the desktop walks that whole chain and names the rung that is broken.
 */
export function StaleBanner({ everSeenClient }: { everSeenClient: boolean }): JSX.Element {
  return (
    <MessageBar intent="warning" layout="singleline">
      <MessageBarBody>
        <MessageBarTitle>
          {everSeenClient
            ? 'No desktop app has synced recently.'
            : 'No desktop app has ever synced this account.'}
        </MessageBarTitle>
        {everSeenClient
          ? 'Changes made here are queued and apply the next time it does. If it is running, ' +
            'check Settings → Cloud → Test connection on that machine.'
          : 'On the desktop app, open Settings → Cloud: switch cloud sync on, sign in to the ' +
            'same account, then press Test connection — it says which part is failing.'}
      </MessageBarBody>
    </MessageBar>
  );
}
