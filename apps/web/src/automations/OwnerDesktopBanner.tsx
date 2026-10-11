import { MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { describeAge } from '../board/syncGate';
import type { OwnerDesktopState } from './ownerDesktop';

/**
 * Names the desktop that owns an automation and when this tab last saw it — the plan doc's
 * own line (`F1-automation-triggers.md`, "UI — web"): *"Changes are queued; nothing fires
 * until ‹desktop› is running."* Automations are evaluated and fired by the one desktop that
 * created them (`Automation.ownerClientId`), never by the cloud service itself, so a browser
 * editing one with that desktop asleep is not idle — it is silently queuing changes an agent
 * will only ever pick up once that specific machine is back.
 *
 * Rendered once per distinct owner on the Automations screen, so an account whose automations
 * were created on two different desktops over time gets two honest banners rather than one
 * that can only be right about one of them.
 */
export function OwnerDesktopBanner({
  name,
  state,
  lastSeen,
  now,
}: {
  name: string;
  state: OwnerDesktopState;
  lastSeen: number | null;
  now: number;
}): JSX.Element {
  if (state === 'live') {
    return (
      <MessageBar intent="success" layout="singleline">
        <MessageBarBody>
          <MessageBarTitle>{name} is running.</MessageBarTitle>
          Its automations fire normally.
        </MessageBarBody>
      </MessageBar>
    );
  }

  const seen =
    state === 'stale' && lastSeen !== null
      ? `Last seen ${describeAge(now - lastSeen)}.`
      : 'This tab has never seen it sync.';

  return (
    <MessageBar intent="warning" layout="singleline">
      <MessageBarBody>
        <MessageBarTitle>{name} is not running.</MessageBarTitle>
        {seen} Changes are queued; nothing fires until {name} is running.
      </MessageBarBody>
    </MessageBar>
  );
}
