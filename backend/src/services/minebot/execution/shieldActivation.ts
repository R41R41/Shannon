// Native identities stay out of the serializable resident-reflex state.
export interface ShieldActivation { at: number; epoch: number; entity: unknown; client: unknown; dimension: unknown }
const activations = new WeakMap<object, ShieldActivation>();
export function recordShieldActivation(state: object, activation: ShieldActivation): void { activations.set(state, activation); }
export function shieldActivation(state: object): ShieldActivation | undefined { return activations.get(state); }
