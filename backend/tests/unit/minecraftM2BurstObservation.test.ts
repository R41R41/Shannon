import { describe, expect, it } from 'vitest';
import { createPublicM2HealthTrace } from '../../scripts/lab/public-m2-observation.js';
import { landingBedRefusalSearch, type BedSearch } from '../../src/services/minebot/utils/dragonBedGeometry.js';
import type { LandingPoint } from '../../src/services/minebot/utils/dragonLandingPath.js';

describe('native M2 health changes across every phase', () => {
  const row = (health: number, sceneTick: number, phase: number | null, source: 'packet' | 'snapshot' = 'packet') => ({ entityId: 17, sceneTick, phase, health, source, body: null });
  it('keeps the initial snapshot distinct and observes damage/healing in phase3, seated and flying phases without changing ACK rules', () => {
    const trace = createPublicM2HealthTrace(17);
    trace.record(row(200, 0, 0, 'snapshot')); trace.record(row(200, 1, 3));
    trace.record(row(180.81231689453125, 1232, 3)); trace.record(row(181.81231689453125, 1280, 6));
    trace.record(row(199, 1700, 5)); trace.record(row(200, 1710, 0));
    expect(trace.state.changes.map(e => [e.sceneTick, e.phase, e.health, e.source])).toEqual([
      [0,0,200,'snapshot'], [1232,3,180.81231689453125,'packet'], [1280,6,181.81231689453125,'packet'], [1700,5,199,'packet'], [1710,0,200,'packet'],
    ]);
    expect(trace.state.changes[1].delta).toBe(-19.18768310546875); expect(trace.state.changes[2].delta).toBe(1);
    expect(trace.state.dropped).toBe(0);
  });
  it('ignores other entities and non-finite HP and keeps a bounded, explicitly truncated trace', () => {
    const trace = createPublicM2HealthTrace(17);
    trace.record({ ...row(10,0,3), entityId: 99 }); trace.record(row(NaN,0,3));
    expect(trace.state.changes).toEqual([]);
    for (let tick=0;tick<2050;tick++) trace.record(row(tick%201,tick,7));
    expect(trace.state.changes).toHaveLength(2048); expect(trace.state.dropped).toBe(2);
  });
});

describe('reuse of the already computed self estimate', () => {
  it('does not add geometry reads/yields or let a diagnostic setter change the refusal', () => {
    const layout = { foot: { x: 3, y: 65, z: 3 }, head: { x: 3, y: 65, z: 2 }, stand: { x: 3.5, y: 62, z: 6.5 }, screen: [], supports: [], selfExposure: 0, headDistance: 0, headDamage: 0, score: 0 };
    const p = { tick: 1, observedTick: 0, forecastTick: 0, phase: 3, position: { x: 100,y: 80,z: 100 }, yaw: 0, velocity: { x: 0,y: 0,z: 0 }, p: 0,hy: 0,yRotA: 0,
      head: { x: 100,y: 80,z: 106.5 }, headBox: { minX: 99.5,maxX: 100.5,minY: 80,maxY: 81,minZ: 106,maxZ: 107 } } satisfies LandingPoint;
    const results = [];
    for (const mode of ['off','capture','mutate','throw']) {
      let reads=0, yields=0, captured: any;
      const sink = mode === 'off' ? undefined : { set self(value: any) { captured=value; if(mode==='mutate') { value.exposure=0; value.expected=0; } if(mode==='throw') throw Error('diagnostic'); } };
      const read = (at: { y: number }) => { reads++; return at.y<62?{name:'bedrock',boundingBox:'block',shapes:[[0,0,0,1,1,1]]}:{name:'air',boundingBox:'empty',shapes:[]}; };
      const search: BedSearch<string|null> = landingBedRefusalSearch(layout,layout.stand,[p],read,20,.5,{},sink);
      let result=search.next(); while(!result.done) { yields++; result=search.next(); }
      results.push({refusal:result.value,reads,yields});
      if(mode==='capture') expect(captured).toMatchObject({exposure:1,model:'normal_before_armour'});
    }
    expect(results[0].refusal).toBe('self_damage');
    expect(results.slice(1)).toEqual([results[0],results[0],results[0]]);
  });
});
