/** Controls the public marketing entry without changing authenticated or hash-based tools. */
export function shouldShowGuestLanding(pathname: string, hash: string, isAuthenticated: boolean): boolean {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (normalized === '/welcome') return true;
  return normalized === '/' && !isAuthenticated && (!hash || hash === '#welcome');
}
