/**
 * Translating paths between Windows and a WSL distro (Phase: WSL execution target).
 *
 * Two different names for the same bytes, and both are needed at once: the agent and
 * `git` run inside the distro and only understand `/home/you/repo`, while the app's
 * own `fs` calls (reading a plan file, watching it for edits) run on Windows and only
 * understand `\\wsl.localhost\Ubuntu\home\you\repo`.
 *
 * There are two mappings, not one:
 *   - a Windows drive is visible to Linux under /mnt   →  C:\src  <->  /mnt/c/src
 *   - the distro's own filesystem is visible to Windows over a UNC share
 *                                                      →  /home/u <->  \\wsl.localhost\<distro>\home\u
 *
 * These are pure string functions with no `wslpath` subprocess, because they run on
 * every path in every command — and because pure means unit-tested against the exact
 * edge cases (drive roots, mixed separators, the legacy `\\wsl$` prefix) rather than
 * against whatever the machine happens to answer.
 *
 * The CANONICAL form stored in the database is the one the host sees (Linux form for a
 * WSL project); the Windows form is derived only where an `fs` call needs it.
 */

/** `/mnt/c/x` — a Windows drive as mounted inside the distro. */
const DRIVE_IN_LINUX = /^\/mnt\/([a-z])(?:\/(.*))?$/i;

/** `C:\x`, `C:/x` or bare `C:` — a Windows path. */
const WINDOWS_DRIVE = /^([A-Za-z]):(?:[\\/](.*))?$/;

/** `\\wsl.localhost\<distro>\x` or the legacy `\\wsl$\<distro>\x`. */
const WSL_UNC = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i;

/**
 * A path as the distro sees it -> a path Windows `fs` can open.
 *
 * `/mnt/c/...` goes back to its real drive letter rather than through the UNC share:
 * same bytes, but far faster and it avoids a pointless round trip out to the 9p server
 * and back onto the same disk.
 */
export function linuxToWindows(linuxPath: string, distro: string): string {
  if (!linuxPath.startsWith('/')) return linuxPath; // relative — not ours to rewrite

  const drive = DRIVE_IN_LINUX.exec(linuxPath);
  if (drive) {
    const letter = drive[1].toUpperCase();
    const rest = drive[2] ?? '';
    return rest ? `${letter}:\\${rest.replace(/\//g, '\\')}` : `${letter}:\\`;
  }

  const rest = linuxPath.slice(1).replace(/\//g, '\\');
  return `\\\\wsl.localhost\\${distro}${rest ? `\\${rest}` : ''}`;
}

/**
 * A path as Windows sees it -> a path the distro sees.
 *
 * Already-Linux input is returned untouched, which makes this safe to apply to a
 * stored project path whether it was picked through the Windows folder dialog (UNC)
 * or typed in Linux form.
 */
export function windowsToLinux(windowsPath: string): string {
  const unc = WSL_UNC.exec(windowsPath);
  if (unc) {
    const rest = (unc[2] ?? '').replace(/\\/g, '/');
    return `/${rest}`;
  }

  const drive = WINDOWS_DRIVE.exec(windowsPath);
  if (drive) {
    const letter = drive[1].toLowerCase();
    const rest = (drive[2] ?? '').replace(/\\/g, '/');
    return rest ? `/mnt/${letter}/${rest}` : `/mnt/${letter}`;
  }

  return windowsPath; // already Linux, or relative
}

/**
 * The distro named by a `\\wsl.localhost\<distro>\...` path, or null.
 *
 * The Windows folder picker returns exactly this shape when the user browses into a
 * distro, so adding a WSL project needs no typed paths: the picked path tells us both
 * which distro it belongs to and where it is inside that distro.
 */
export function distroFromWindowsPath(windowsPath: string): string | null {
  const unc = WSL_UNC.exec(windowsPath);
  return unc ? unc[1] : null;
}

/** True when this path lives on the distro's own filesystem rather than a Windows drive. */
export function isDistroPath(linuxPath: string): boolean {
  return linuxPath.startsWith('/') && !DRIVE_IN_LINUX.test(linuxPath);
}

/**
 * Whether a path is written in the shape the given machine can open — used to warn on
 * a form BEFORE the mismatch becomes a run that dies at its first `cd`.
 *
 * The two failure modes are equally easy to type and equally confusing to debug: a
 * `C:\repo` handed to a Linux shell, and a `/home/you/repo` handed to Windows `fs`.
 * A UNC path counts as wrong for BOTH — it is a Windows spelling of a Linux location,
 * so nothing executes it; `windowsToLinux` exists to convert it, and the pickers do.
 *
 * Deliberately permissive about what it cannot know: an empty path, or anything that is
 * neither clearly Windows nor clearly absolute-Linux (a relative path, a typo in
 * progress), is not called a mismatch — a form that scolds you mid-keystroke is worse
 * than one that stays quiet until it is sure.
 */
export function pathSuitsHost(path: string, host: 'windows' | 'linux'): boolean {
  const trimmed = path.trim();
  if (!trimmed) return true;
  if (WSL_UNC.test(trimmed)) return false;
  if (WINDOWS_DRIVE.test(trimmed)) return host === 'windows';
  if (trimmed.startsWith('/')) return host === 'linux';
  return true; // relative or unrecognised — not ours to judge
}

/**
 * Join path segments in the HOST's own shape.
 *
 * `node:path.join` builds whatever the *app's* platform uses, which is wrong the
 * moment the path belongs to another machine: joining `/home/you` with `.claude` on
 * Windows yields `/home/you\.claude`, which no Linux tool will open. The separator
 * follows the base path, not the process.
 */
export function hostJoin(base: string, ...segments: string[]): string {
  const posix = base.startsWith('/');
  const sep = posix ? '/' : '\\';
  const trimmed = base.replace(/[\\/]+$/, '');
  const head = trimmed === '' && posix ? '' : trimmed;
  return [head, ...segments].join(sep);
}
