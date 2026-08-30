import type { IdentityBindingLookup } from '../../modules/identity/resolveBinding.js';

let lookup: IdentityBindingLookup | null = null;

export function registerIdentityBindingLookup(next: IdentityBindingLookup): void {
  if (lookup) throw new Error('IdentityBindingLookup already registered');
  lookup = next;
}

export function getIdentityBindingLookup(): IdentityBindingLookup | null {
  return lookup;
}

export function resetIdentityBindingLookupForTests(): void {
  lookup = null;
}
