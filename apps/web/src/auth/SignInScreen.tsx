import { Button, Caption1, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { CloudRegular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
  },
  icon: { fontSize: '48px', color: tokens.colorBrandForeground1 },
  error: { color: tokens.colorPaletteRedForeground1, maxWidth: '360px', textAlign: 'center' },
});

export interface SignInScreenProps {
  loading: boolean;
  error: string | null;
  onSignIn: () => void;
}

/** Shown before `useCloudAuth` has resolved a possible `/callback` redirect, and whenever
 *  there is no refresh token on file — the same screen covers both, since neither has a
 *  board to show yet. */
export function SignInScreen({ loading, error, onSignIn }: SignInScreenProps): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <CloudRegular className={styles.icon} />
      <Text size={600} weight="semibold">
        VIPPER Task Manager Cloud
      </Text>
      {loading ? (
        <Spinner label="Signing you in…" />
      ) : (
        <>
          <Caption1>Sign in with your vipper.iam account to see your board.</Caption1>
          {error && <Caption1 className={styles.error}>{error}</Caption1>}
          <Button appearance="primary" onClick={onSignIn}>
            Sign in with vipper.iam
          </Button>
        </>
      )}
    </div>
  );
}
