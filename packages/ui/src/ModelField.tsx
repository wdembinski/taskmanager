/**
 * The one model picker every form renders — the reason `PlanningModelField` and
 * `BaseBranchField` already exist: several forms each spelling "pick a Claude model" their
 * own way would eventually disagree about what a value even means. `ClaudeModel` now accepts
 * an alias, a pinned version, or a hand-typed custom id (`@tm/shared/model`), which is exactly
 * the surface a plain `MODELS.map(...)` dropdown can no longer represent — this is what
 * replaces it everywhere, one caller at a time ("Wire every model picker to the catalog").
 *
 * A caller that needs an empty choice ("same as execution", "project default", …) passes its
 * own sentinel value/label through {@link ModelFieldProps.sentinel} rather than this control
 * inventing one — `PlanningModelField`'s `SAME_AS_EXECUTION` and `modelChoice.ts`'s
 * `PROJECT_DEFAULT` keep meaning exactly what they already mean, they just render here now.
 *
 * **Transport-tier fallback.** The grouped list always starts from the static
 * `MODEL_CATALOG` and renders it immediately, unlabelled; a `model:catalog` fetch then fills
 * in each option's live caption (`opus — Opus 5`) when it resolves. If it never resolves — no
 * desktop reachable from the web, a stale cache, whatever — the picker still works, just
 * without the labels. It must never gate its own render on that relayed call: that is the
 * bootstrap deadlock the web Settings PAT page already had to be rescued from (a whole page
 * blocked on one relayed read, including the read that would have fixed the relay).
 *
 * **No Field, no custom box.** `label` is optional: omitting it skips the `Field` wrapper
 * entirely and renders a bare `Dropdown`, for a caller that already supplies its own label
 * (the composer's footer strip, which names itself with a glyph and a `Caption1` beside the
 * picker). `allowCustom` (default `true`) is the composer's other reason to exist: its footer
 * has no room for a text box and a live resolve caption, so it renders the catalog and the
 * sentinel only — but a card already pinned to a model the catalog doesn't list must still
 * show and stay selectable, so a `false` value renders that one value as a plain option of its
 * own rather than silently dropping it. Typing a NEW custom id stays the assign dialog's job.
 */
import {
  Caption1,
  Dropdown,
  Field,
  Input,
  Option,
  OptionGroup,
  makeStyles,
  tokens,
  type OptionOnSelectData,
} from '@fluentui/react-components';
import { useEffect, useRef, useState } from 'react';
import {
  MODEL_CATALOG,
  isUsableModel,
  type ModelCatalogEntry,
  type ModelFamily,
  type ModelResolution,
} from '@tm/shared/model';
import { useTransport } from './transport';

/**
 * The option value standing for "type your own id" — the leading `..` keeps it out of the
 * model namespace, the same trick (and the same reason) as every other sentinel in this
 * codebase (`SAME_AS_EXECUTION`, `PROJECT_DEFAULT`, `FOLLOW_CHECKOUT`).
 */
export const CUSTOM_MODEL = '..custom-model';

const FAMILY_LABEL: Record<ModelFamily, string> = {
  haiku: 'Haiku',
  sonnet: 'Sonnet',
  opus: 'Opus',
  fable: 'Fable',
};

/** How long to wait after the last keystroke before spending a `model:resolve` probe on it. */
const RESOLVE_DEBOUNCE_MS = 300;

/**
 * The catalog laid out the way the dropdown renders it: every alias first (so "opus" reads
 * before "claude-opus-4-7"), then each family's pinned versions as their own group, in the
 * order their family first appears among the versions. Pure and exported so the grouping can
 * be asserted without mounting anything.
 */
export function groupCatalog(catalog: readonly ModelCatalogEntry[] = MODEL_CATALOG): {
  aliases: ModelCatalogEntry[];
  versionGroups: { family: ModelFamily; entries: ModelCatalogEntry[] }[];
} {
  const aliases = catalog.filter((entry) => entry.kind === 'alias');
  const familyOrder: ModelFamily[] = [];
  const byFamily = new Map<ModelFamily, ModelCatalogEntry[]>();
  for (const entry of catalog) {
    if (entry.kind !== 'version') continue;
    let bucket = byFamily.get(entry.family);
    if (!bucket) {
      bucket = [];
      byFamily.set(entry.family, bucket);
      familyOrder.push(entry.family);
    }
    bucket.push(entry);
  }
  return {
    aliases,
    versionGroups: familyOrder.map((family) => ({ family, entries: byFamily.get(family) ?? [] })),
  };
}

/**
 * How one catalog row reads in the list: the bare id until a resolution has come back for it
 * (the transport-tier fallback — see the file header), `id — Label` once the CLI confirms it
 * knows the id, and an explicit "unrecognized" suffix — never a dropped row — once it says it
 * doesn't. A project already pinned to that id must still find it here.
 */
export function optionCaption(id: string, resolution: ModelResolution | undefined): string {
  if (!resolution) return id;
  return resolution.known ? `${id} — ${resolution.label}` : `${id} — unrecognized by this CLI`;
}

/**
 * Whether `value` is something the catalog and the sentinel do NOT already say — i.e. this
 * is a custom id (typed by hand, or pinned by a project before this catalog knew about it)
 * that the "Custom…" box has to carry rather than the grouped list.
 */
export function isCustomValue(
  value: string,
  sentinelValue: string | undefined,
  catalog: readonly ModelCatalogEntry[] = MODEL_CATALOG,
): boolean {
  return value !== '' && value !== sentinelValue && !catalog.some((entry) => entry.id === value);
}

/**
 * The custom box's live caption once a `model:resolve` probe has answered for the text
 * currently in it — null while there is nothing to say yet (empty, mid-debounce, or the text
 * isn't even shaped like a model id, which `isUsableModel` already refused before probing).
 */
export function customCaption(resolution: ModelResolution | null): string | null {
  if (!resolution) return null;
  return resolution.known
    ? `Runs as: ${resolution.label}`
    : "The installed CLI doesn't recognize this model.";
}

const SHAPE_ERROR =
  'A model id may only contain letters, digits, "." "_" "-", up to 64 characters.';

export interface ModelFieldSentinel {
  /** The stored value this option means — a caller's own `null`-standing sentinel. */
  value: string;
  /** How it reads, already composed (e.g. `sameLabel`/`projectDefaultLabel`'s output). */
  label: string;
}

export interface ModelFieldProps {
  /** Omitted for a bare `Dropdown` with no `Field`/label of its own — see the file header. */
  label?: string;
  hint?: string;
  /** Applied to the `Field` wrapper when `label` is given; to the `Dropdown` itself when it's
   *  not, since there is no `Field` to apply it to. */
  className?: string;
  /** Applied to the `Dropdown` itself regardless of `label` — for a caller that needs both a
   *  Field-sized class and a Dropdown-sized one (Fluent's `Dropdown` hard-codes its own
   *  `minWidth`, which a `Field` cannot override from the outside). */
  dropdownClassName?: string;
  /** The stored value: the sentinel's value, a catalog id, or a custom model id. */
  value: string;
  /**
   * Fires for a catalog pick immediately, and for a custom id only once it's
   * {@link isUsableModel}-shaped — an id that fails the shape check is never handed up, which
   * is what keeps a caller's Save button from ever persisting one.
   */
  onChange: (value: string) => void;
  /** A leading option standing for "not one of these" — see {@link ModelFieldSentinel}. */
  sentinel?: ModelFieldSentinel;
  /** Whether "Custom…" and its text box are offered. Default `true` — see the file header. */
  allowCustom?: boolean;
  /** Forwarded to the underlying `Dropdown`. */
  size?: 'small' | 'medium' | 'large';
  /** Forwarded to the underlying `Dropdown`. */
  appearance?: 'outline' | 'underline' | 'filled-darker' | 'filled-lighter';
  /** Forwarded to the underlying `Dropdown` — a hover tooltip, for a caller with no `hint`
   *  (no `Field`) to hang one off instead. */
  title?: string;
}

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  note: { color: tokens.colorNeutralForeground3 },
  warning: { color: tokens.colorPaletteYellowForeground1 },
  error: { color: tokens.colorPaletteRedForeground1 },
});

/**
 * The live `model:catalog` probe, shared by {@link ModelField} and {@link useModelLabels} — a
 * `null` map (the transport-tier fallback, see the file header) until the fetch resolves, then
 * every id the CLI has answered for so far.
 */
function useModelResolutions(): Map<string, ModelResolution> | null {
  const transport = useTransport();
  const [resolutions, setResolutions] = useState<Map<string, ModelResolution> | null>(null);
  useEffect(() => {
    let cancelled = false;
    transport
      .invoke('model:catalog')
      .then((rows) => {
        if (cancelled) return;
        setResolutions(new Map(rows.map((r) => [r.id, r])));
      })
      .catch(() => {
        // No desktop reachable, or the probe itself failed — the caller's own fallback (an
        // unlabelled catalog, or a raw id) already covers this.
      });
    return () => {
      cancelled = true;
    };
  }, [transport]);
  return resolutions;
}

/**
 * A model id to the CLI's own display name, for a read-only echo that isn't `ModelField`
 * itself — `cardModelCaption`/`modelCaption` (`./modelChoice`) take a `labelOf` lookup for
 * exactly this, so a project or card reads "Opus 5" rather than "claude-opus-5". Falls back to
 * the bare id until the probe answers, or forever if it never does — the same transport-tier
 * fallback `ModelField` itself uses, and for the same reason: this must never gate a render on
 * a relayed call resolving.
 */
export function useModelLabels(): (id: string) => string {
  const resolutions = useModelResolutions();
  return (id: string): string => resolutions?.get(id)?.label ?? id;
}

export function ModelField({
  label,
  hint,
  className,
  dropdownClassName,
  value,
  onChange,
  sentinel,
  allowCustom = true,
  size,
  appearance,
  title,
}: ModelFieldProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const resolutions = useModelResolutions();
  const { aliases, versionGroups } = groupCatalog();

  const startsCustom = allowCustom && isCustomValue(value, sentinel?.value);
  const [customOpen, setCustomOpen] = useState(startsCustom);
  const [customText, setCustomText] = useState(startsCustom ? value : '');
  const [customResolution, setCustomResolution] = useState<ModelResolution | null>(null);

  // The caller reset `value` out from under us (Cancel, a fresh card, …) — follow it.
  useEffect(() => {
    const custom = allowCustom && isCustomValue(value, sentinel?.value);
    setCustomOpen(custom);
    setCustomText(custom ? value : '');
  }, [value, sentinel?.value, allowCustom]);

  const probeGeneration = useRef(0);
  useEffect(() => {
    if (!customOpen || !isUsableModel(customText)) {
      setCustomResolution(null);
      return;
    }
    const mine = ++probeGeneration.current;
    const timer = setTimeout(() => {
      transport
        .invoke('model:resolve', customText)
        .then((res) => {
          if (probeGeneration.current === mine) setCustomResolution(res);
        })
        .catch(() => {
          if (probeGeneration.current === mine) setCustomResolution(null);
        });
    }, RESOLVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [customOpen, customText, transport]);

  function handleSelect(data: OptionOnSelectData): void {
    if (data.optionValue === undefined) return;
    if (allowCustom && data.optionValue === CUSTOM_MODEL) {
      setCustomOpen(true);
      setCustomText('');
      return;
    }
    setCustomOpen(false);
    onChange(data.optionValue);
  }

  function handleCustomTextChange(text: string): void {
    setCustomText(text);
    if (isUsableModel(text)) onChange(text);
  }

  const shapeError =
    customOpen && customText !== '' && !isUsableModel(customText) ? SHAPE_ERROR : null;
  const caption = customCaption(customResolution);

  const selectedOption = customOpen ? CUSTOM_MODEL : value || sentinel?.value || '';
  const displayValue = customOpen
    ? customText
      ? `Custom: ${customText}`
      : 'Custom…'
    : value === sentinel?.value
      ? (sentinel?.label ?? '')
      : optionCaption(value, resolutions?.get(value) ?? undefined);

  // A value already pinned outside the catalog has to stay visible and selectable even with
  // custom typing turned off — see the file header.
  const pinnedCustom = !allowCustom && isCustomValue(value, sentinel?.value);

  // No `Field` to carry `className` when there is no `label` — the Dropdown wears it instead.
  const dropdownClass =
    [label === undefined ? className : undefined, dropdownClassName].filter(Boolean).join(' ') ||
    undefined;

  const dropdown = (
    <Dropdown
      className={dropdownClass}
      size={size}
      appearance={appearance}
      title={title}
      value={displayValue}
      selectedOptions={[selectedOption]}
      onOptionSelect={(_e, data) => handleSelect(data)}
    >
      {sentinel && <Option value={sentinel.value}>{sentinel.label}</Option>}
      <OptionGroup label="Aliases">
        {aliases.map((entry) => (
          <Option key={entry.id} value={entry.id} text={entry.id}>
            {optionCaption(entry.id, resolutions?.get(entry.id))}
          </Option>
        ))}
      </OptionGroup>
      {versionGroups.map(({ family, entries }) => (
        <OptionGroup key={family} label={FAMILY_LABEL[family]}>
          {entries.map((entry) => (
            <Option key={entry.id} value={entry.id} text={entry.id}>
              {optionCaption(entry.id, resolutions?.get(entry.id))}
            </Option>
          ))}
        </OptionGroup>
      ))}
      {pinnedCustom && (
        <Option value={value} text={value}>
          {optionCaption(value, resolutions?.get(value))}
        </Option>
      )}
      {allowCustom && (
        <Option value={CUSTOM_MODEL} text="Custom…">
          Custom…
        </Option>
      )}
    </Dropdown>
  );

  const customBox = allowCustom && customOpen && (
    <>
      <Input
        value={customText}
        onChange={(_e, data) => handleCustomTextChange(data.value)}
        placeholder="claude-opus-4-7, or any model id the CLI accepts"
      />
      {shapeError ? (
        <Caption1 className={styles.error}>{shapeError}</Caption1>
      ) : caption ? (
        <Caption1 className={customResolution?.known ? styles.note : styles.warning}>
          {caption}
        </Caption1>
      ) : null}
    </>
  );

  if (label === undefined) {
    return customBox ? (
      <div className={styles.stack}>
        {dropdown}
        {customBox}
      </div>
    ) : (
      dropdown
    );
  }

  return (
    <Field label={label} hint={hint} className={className}>
      <div className={styles.stack}>
        {dropdown}
        {customBox}
      </div>
    </Field>
  );
}
