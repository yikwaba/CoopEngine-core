/** Reset secrets travel in the URL fragment, never a request query string. */
export function resetTokenFromFragment(fragment: string): string {
  const token = fragment.startsWith('#') ? fragment.slice(1) : '';
  return /^[a-f0-9]{64}$/.test(token) ? token : '';
}
