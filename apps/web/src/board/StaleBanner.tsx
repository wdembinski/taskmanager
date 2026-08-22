import { MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';

/**
 * The honesty check this step's own brief asks for — but a narrower one than it used to be.
 * Creating and editing cards and projects applies straight from this tab regardless of any
 * desktop Client (`httpTransport.ts`'s direct tier), so a missing or stale Client is no
 * longer a reason to warn someone off editing. What is still true without one: relayed
 * commands — running an agent, chat, comments, attachments, credentials, native pickers —
 * have nobody to carry them out, and any of THOSE queued now sit there until a desktop
 * Client syncs (see `ClientPresence`'s own docstring on `@tm/protocol/wire`).
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
        Creating and editing cards and projects still works from here. Running an agent, chat,
        comments, attachments and credentials need a desktop app open and{' '}
        {everSeenClient ? 'apply the next time it syncs.' : 'have never had one to run them.'}
      </MessageBarBody>
    </MessageBar>
  );
}
