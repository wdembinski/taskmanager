/**
 * Insert-template menu (F7.10) — a small button that lists the {@link PromptTemplate}s
 * offered on one `surface` and hands the pick back to the caller.
 *
 * Reads `AppSettings.promptTemplates` itself, via `settings:get`, the same on-demand way
 * `AddTaskDialog` reads its JIRA metadata and `AssignAgentDialog` reads `branchPrefix` — so
 * dropping this into a composer costs no new prop threaded through every caller of that
 * composer's own dialog. Renders nothing while none of the saved templates are offered on
 * `surface`, rather than a button that would only ever open onto an empty list.
 *
 * Deliberately knows nothing about HOW a pick is applied — the caret math and the
 * surface-specific insertion (plain text vs. a chat `ComposerValue`) live in
 * `templateInsert.ts`; this component's only job is the picker.
 */
import { useEffect, useState } from 'react';
import {
  Button,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@fluentui/react-components';
import { DocumentBulletListRegular } from '@fluentui/react-icons';
import {
  templatesFor,
  type PromptTemplate,
  type PromptTemplateSurface,
} from '@tm/shared/promptTemplates';
import { useTransport } from './transport';

export interface TemplateMenuProps {
  surface: PromptTemplateSurface;
  onPick: (template: PromptTemplate) => void;
  size?: 'small' | 'medium';
}

export function TemplateMenu({
  surface,
  onPick,
  size = 'small',
}: TemplateMenuProps): JSX.Element | null {
  const transport = useTransport();
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);

  useEffect(() => {
    let live = true;
    void transport.invoke('settings:get').then((settings) => {
      if (live) setTemplates(templatesFor(settings.promptTemplates, surface));
    });
    return () => {
      live = false;
    };
  }, [transport, surface]);

  if (templates.length === 0) return null;

  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button size={size} appearance="subtle" icon={<DocumentBulletListRegular />}>
          Template
        </Button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {templates.map((template) => (
            <MenuItem key={template.id} onClick={() => onPick(template)}>
              {template.name}
            </MenuItem>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
