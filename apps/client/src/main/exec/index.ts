/**
 * The execution-host registry.
 *
 * Hosts are cached per target: a `WslExecHost` probes its distro (home directory,
 * readiness) and there is no reason for every task to repeat that. `localHost()` is
 * the default everything falls back to, so a project with no target configured — and
 * every code path not yet threaded through a project — behaves exactly as before.
 */
import { LocalExecHost } from './localHost';
import { WslExecHost } from './wslHost';
import type { ExecHost, ExecTarget } from './types';

export * from './types';
export { LocalExecHost } from './localHost';
export { WslExecHost } from './wslHost';
export { localReadiness, readinessFor, statusForTargets } from './readiness';
export { decodeWslListing, listWslDistros, parseDistroList, probeWslTarget } from './wsl';
// Path translation is pure and the renderer needs it too (to recognize a folder
// picked inside a distro), so it lives in `shared` and is re-exported here.
export {
  distroFromWindowsPath,
  hostJoin,
  isDistroPath,
  linuxToWindows,
  windowsToLinux,
} from '@shared/wslPath';

const local = new LocalExecHost();
const wslHosts = new Map<string, WslExecHost>();

/** The host for the machine the GUI runs on. */
export function localHost(): ExecHost {
  return local;
}

/**
 * The host for a target, reusing one instance per distro so a probed home directory
 * is resolved once rather than on every task.
 */
export function hostFor(target: ExecTarget | undefined): ExecHost {
  if (!target || target.kind === 'local') return local;
  let host = wslHosts.get(target.distro);
  if (!host) {
    host = new WslExecHost(target.distro);
    wslHosts.set(target.distro, host);
  }
  return host;
}
