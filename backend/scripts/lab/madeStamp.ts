/**
 * What the head puts on a command that moves the body (continue contracts 2 and 5): the life number and what the decision read (`madeIn`: the life, the dimension and its
 * generation, the body's start-up and connection ids, the head's start-up id, the observation's number). A command without it is refused as `life_missing` (lapse.ts).
 *
 * The lab probes that call `NativeCommonFcaBody.execute` themselves (hands-live, incident-lab, replay) are the head here, so they take it from the body's own
 * observation at the moment each command is made, as the head does. The body itself always has its life keeper (`NativeCommonFcaBody` installs it), so a command that
 * carries this is started like any other.
 */
export interface MadeStampBody { observe(): { sequence: number; state: unknown } }
export function madeStamp(body: MadeStampBody, headBoot = 'hb-lab-probe'): { life: number; headBoot: string; madeIn: Record<string, unknown> } {
  const observation = body.observe();
  const state = observation.state as { life: { life: number; dimension: string; dimensionSince: string }; bodyRun: { bodyBoot: string; connectionId: string } };
  const madeIn = { life: state.life.life, dim: state.life.dimension, dimSince: state.life.dimensionSince, bodyBoot: state.bodyRun.bodyBoot, connectionId: state.bodyRun.connectionId,
    headBoot, obsSeq: observation.sequence };
  return { life: madeIn.life, headBoot, madeIn };
}
