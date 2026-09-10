import { describe, expect, it } from 'vitest';
import type { Person } from '@tm/shared/model';
import { assigneeDisplayParts } from './assigneeParts';

const person = (over: Partial<Person> = {}): Pick<Person, 'name' | 'initials' | 'color'> => ({
  name: 'Ada Lovelace',
  initials: 'AL',
  color: '#123456',
  ...over,
});

describe('assigneeDisplayParts', () => {
  it('draws nothing for neither an assignee nor an agent', () => {
    expect(assigneeDisplayParts(undefined, undefined)).toBeNull();
  });

  it('draws only the human, titled with their name, when there is no agent', () => {
    const parts = assigneeDisplayParts(person(), undefined);
    expect(parts).toEqual({ assignee: person(), agentName: undefined, title: 'Ada Lovelace' });
  });

  it('draws only the agent, titled with its name, when there is no human assignee', () => {
    const parts = assigneeDisplayParts(undefined, 'Bot Repo');
    expect(parts).toEqual({ assignee: undefined, agentName: 'Bot Repo', title: 'Bot Repo' });
  });

  it("joins both names with ' / ' when a ticket has a human assignee and a delegated agent", () => {
    const parts = assigneeDisplayParts(person(), 'Bot Repo');
    expect(parts).toEqual({
      assignee: person(),
      agentName: 'Bot Repo',
      title: 'Ada Lovelace / Bot Repo',
    });
  });

  it('lets a caller override the resolved title', () => {
    const parts = assigneeDisplayParts(
      person(),
      'Bot Repo',
      'Assigned to Ada · delegated to Bot Repo',
    );
    expect(parts?.title).toBe('Assigned to Ada · delegated to Bot Repo');
  });
});
