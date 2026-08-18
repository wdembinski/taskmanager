import { MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';

/**
 * This tab cannot read the board at all — the reads are failing, not coming back empty.
 *
 * It exists because the alternative was a wrong diagnosis, printed confidently. `BoardPoller`
 * reported a failed read to `console.warn` and nothing else, so a tab whose every poll was
 * failing looked exactly like a tab whose polls were fine and whose account had nothing on it:
 * an empty board, a red dot, and `StaleBanner` blaming the desktop app — *"No desktop app has
 * ever synced this account"* — while the desktop was in fact syncing perfectly and the browser
 * simply could not see any of it. That sentence is what sends somebody to the wrong machine.
 *
 * So this outranks `StaleBanner` (see `App.tsx`): until a read comes back, nothing this tab
 * could say about desktop clients is worth saying, because it has not heard from the server.
 *
 * The message is the fetch's own — `board read failed (401 …)`, `Not signed in to vipper.iam.`,
 * or a bare `Failed to fetch`, which is what a browser calls a blocked origin or a dropped
 * network. Verbatim rather than translated: the four causes need four different fixes, and a
 * single friendly sentence covering all of them would name none.
 */
export function UnreachableBanner({ message }: { message: string }): JSX.Element {
  return (
    <MessageBar intent="error" layout="singleline">
      <MessageBarBody>
        <MessageBarTitle>This tab cannot reach the cloud service.</MessageBarTitle>
        {message} — the board below is whatever was last read, not what is there now.
      </MessageBarBody>
    </MessageBar>
  );
}
