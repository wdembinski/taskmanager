/**
 * The Personal access tokens pane — the ONLY place a cloud credential is minted, now that the
 * desktop no longer signs in on its own. Create a token here, paste it into the desktop app's
 * Cloud settings, and it works until it expires or is revoked from this list.
 *
 * All the copy and sorting logic lives in `tokensView.ts`, which is unit-tested directly — this
 * component has no rule in it that is not already covered there.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CopyRegular, DismissRegular } from '@fluentui/react-icons';
import type { PersonalAccessToken } from '@tm/protocol/wire';
import { createToken, listTokens, revokeToken, type TokensApiDeps } from './tokensApi';
import {
  PAT_DEFAULT_EXPIRY_DAYS,
  PAT_EXPIRY_CHOICES,
  describeExpiry,
  describeLastUsed,
  sortTokens,
  validateTokenName,
} from './tokensView';

const useStyles = makeStyles({
  grid: { display: 'flex', flexDirection: 'column', gap: '16px' },
  row: { display: 'flex', alignItems: 'flex-end', gap: '12px', flexWrap: 'wrap' },
  list: { display: 'flex', flexDirection: 'column', gap: '8px' },
  tokenRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '8px 12px',
    borderRadius: '4px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  tokenMeta: { display: 'flex', flexDirection: 'column', gap: '2px' },
  confirmRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  secretRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  secret: {
    fontFamily: 'monospace',
    padding: '2px 6px',
    borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground3,
  },
  hint: { color: tokens.colorNeutralForeground3 },
});

export type TokensSectionProps = TokensApiDeps;

export function TokensSection(props: TokensSectionProps): JSX.Element {
  const styles = useStyles();
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<number | null>(PAT_DEFAULT_EXPIRY_DAYS);
  const [nameError, setNameError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<{
    token: string;
    pat: PersonalAccessToken;
  } | null>(null);

  const [tokenList, setTokenList] = useState<PersonalAccessToken[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { tokens: list } = await listTokens(props);
      setTokenList(list);
      setListError(null);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    }
    // `props` is a fresh object every render (App.tsx passes `getAccessToken={() => …}`
    // inline), so depending on it would refetch on every keystroke in the form above. The
    // effect below runs this once on mount, which is all a list this rarely changes needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onCreate = async (): Promise<void> => {
    const error = validateTokenName(name);
    setNameError(error);
    if (error) return;

    setCreating(true);
    setCreateError(null);
    try {
      const created = await createToken(props, { name: name.trim(), expiresInDays });
      setJustCreated(created);
      setName('');
      setExpiresInDays(PAT_DEFAULT_EXPIRY_DAYS);
      await refresh();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const onRevoke = async (id: string): Promise<void> => {
    setRevokingId(id);
    try {
      await revokeToken(props, id);
      setConfirmingId(null);
      await refresh();
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevokingId(null);
    }
  };

  const now = Date.now();
  const sorted = tokenList ? sortTokens(tokenList) : [];

  return (
    <div className={styles.grid}>
      <Subtitle2>Personal access tokens</Subtitle2>
      <Body1 className={styles.hint}>
        What the desktop app uses instead of signing in. The server mints this token for you right
        here — it never crosses a relay and never lands in the desktop’s command log. Create one,
        paste it into the desktop app’s Cloud settings, and it works until it expires or you revoke
        it below: full read-and-write access to your account’s mirror, nothing narrower.
      </Body1>

      <div className={styles.row}>
        <Field
          label="Name"
          validationState={nameError ? 'error' : 'none'}
          validationMessage={nameError ?? undefined}
        >
          <Input
            value={name}
            placeholder="e.g. work laptop"
            onChange={(_e, d) => {
              setName(d.value);
              if (nameError) setNameError(null);
            }}
          />
        </Field>
        <Field label="Expires">
          <Dropdown
            value={expiryOptionLabel(expiresInDays)}
            selectedOptions={[String(expiresInDays)]}
            onOptionSelect={(_e, d) =>
              setExpiresInDays(d.optionValue === 'null' ? null : Number(d.optionValue))
            }
          >
            {PAT_EXPIRY_CHOICES.map((days) => (
              <Option key={String(days)} value={String(days)}>
                {expiryOptionLabel(days)}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Button appearance="primary" disabled={creating} onClick={() => void onCreate()}>
          Create token
        </Button>
      </div>
      {createError && (
        <MessageBar intent="error">
          <MessageBarBody>{createError}</MessageBarBody>
        </MessageBar>
      )}

      {justCreated && (
        <MessageBar intent="success">
          <MessageBarBody>
            <div className={styles.secretRow}>
              <code className={styles.secret}>{justCreated.token}</code>
              <Button
                size="small"
                icon={<CopyRegular />}
                onClick={() => void navigator.clipboard.writeText(justCreated.token)}
              >
                Copy
              </Button>
              <Button
                size="small"
                appearance="subtle"
                icon={<DismissRegular />}
                title="Dismiss"
                onClick={() => setJustCreated(null)}
              />
            </div>
            <Caption1>
              This is the only time it will be shown — copy it now and paste it into the desktop
              app’s Cloud settings.
            </Caption1>
          </MessageBarBody>
        </MessageBar>
      )}

      {listError && (
        <MessageBar intent="error">
          <MessageBarBody>{listError}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.list}>
        {tokenList !== null && sorted.length === 0 && (
          <Caption1 className={styles.hint}>No tokens yet.</Caption1>
        )}
        {sorted.map((pat) => (
          <div key={pat.id} className={styles.tokenRow}>
            <div className={styles.tokenMeta}>
              <Body1>
                {pat.name} <span className={styles.hint}>({pat.hint}…)</span>
              </Body1>
              <Caption1 className={styles.hint}>
                {pat.revokedAt !== null
                  ? 'Revoked'
                  : `${describeExpiry(pat, now)} · ${describeLastUsed(pat, now)}`}
              </Caption1>
            </div>
            {pat.revokedAt === null &&
              (confirmingId === pat.id ? (
                <div className={styles.confirmRow}>
                  <Caption1>Revoke this token?</Caption1>
                  <Button
                    size="small"
                    appearance="primary"
                    disabled={revokingId === pat.id}
                    onClick={() => void onRevoke(pat.id)}
                  >
                    Confirm
                  </Button>
                  <Button size="small" appearance="subtle" onClick={() => setConfirmingId(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button size="small" appearance="subtle" onClick={() => setConfirmingId(pat.id)}>
                  Revoke
                </Button>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function expiryOptionLabel(days: number | null): string {
  return days === null ? 'No expiry' : `${days} days`;
}
