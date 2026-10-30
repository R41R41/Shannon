import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeSim, type Sim } from '../helpers/physicsBody.js';
import { runCover } from '../../src/services/minebot/utils/floorReflexes.js';

// The physics world supplies the authoritative block update; only the wire confirmation is a stand-in here.
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', async original => ({
  ...await original<typeof import('../../src/services/minebot/utils/digBlockVerified.js')>(),
  digBlockVerified: async (bot: any, block: any) => { await bot.dig(block); return {stateId:0,blockName:'air'}; },
}));
await import('../../src/services/minebot/utils/primitives/dig.js');
await import('../../src/services/minebot/utils/tunnelWalk.js');

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }));
afterEach(() => vi.useRealTimers());
async function drive<T>(sim: Sim, promise: Promise<T>) {
  let ended=false; promise.finally(()=>{ended=true;});
  for(let t=0;t<8_000&&!ended;t+=50){sim.tick();await vi.advanceTimersByTimeAsync(50);}
  return promise;
}

describe('run52: a cover dig must lower the body, not just remove a block',()=>{
  it('centres a body overlapping the neighbouring floor before digging, and proves the drop',async()=>{
    const sim=makeSim((_x,y,_z)=>y<64?'dirt':'air',{start:[0.54,64,0.04],digMs:100});
    const result=await drive(sim,runCover(sim.bot,sim.bot,{kind:'dig',cell:{x:0,y:63,z:0},detail:'cover dig'}));
    expect(result.success).toBe(true);
    expect(sim.bot.entity.position.y).toBeCloseTo(63,1);
    expect(Math.abs(sim.bot.entity.position.z-0.5)).toBeLessThanOrEqual(0.2);
    expect(sim.bot.dugBlocks).toHaveLength(1);
    expect(sim.bot.controlState.forward).not.toBe(true);
    expect(sim.bot.controlState.sneak).not.toBe(true);
  });
  it('descends in the recorded run52 column after the second arrow, on the saved real terrain',async()=>{
    const f=JSON.parse(fs.readFileSync(new URL('../fixtures/run52-hold2-cover.json',import.meta.url),'utf8'));
    const cells=f.runs.flatMap(([i,n]:number[])=>Array(n).fill(i));
    const [ox,oy,oz]=f.origin,[sx,sy,sz]=f.size;
    const ground=(x:number,y:number,z:number)=>x<ox||y<oy||z<oz||x>=ox+sx||y>=oy+sy||z>=oz+sz?null:f.palette[cells[((y-oy)*sz+z-oz)*sx+x-ox]];
    const sim=makeSim(ground,{start:f.feet,items:f.items,digMs:100});
    const result=await drive(sim,runCover(sim.bot,sim.bot,{kind:'dig',cell:{x:-494,y:58,z:-194},detail:'recorded cover dig'}));
    expect(result.success).toBe(true);
    expect(sim.bot.entity.position.y).toBeCloseTo(58,1);
    expect(Math.floor(sim.bot.entity.position.x)).toBe(-494);
    expect(Math.floor(sim.bot.entity.position.z)).toBe(-194);
  });
  it('does not dig the old cell after a knockback has moved the body elsewhere',async()=>{
    const sim=makeSim((_x,y,_z)=>y<64?'dirt':'air',{start:[1.5,64,0.5],digMs:100});
    const result=await drive(sim,runCover(sim.bot,sim.bot,{kind:'dig',cell:{x:0,y:63,z:0},detail:'cover dig'}));
    expect(result.success).toBe(false);
    expect(sim.bot.dugBlocks).toEqual([]);
  });
  it('does not claim a descent if the server leaves the supporting floor in place',async()=>{
    const sim=makeSim((_x,y,_z)=>y<64?'dirt':'air',{start:[0.5,64,0.5],digMs:100,ghost:(_x,y,_z)=>y===63?'dirt':undefined});
    const result=await drive(sim,runCover(sim.bot,sim.bot,{kind:'dig',cell:{x:0,y:63,z:0},detail:'cover dig'}));
    expect(result.success).toBe(false);
    expect(sim.bot.entity.position.y).toBeCloseTo(64,1);
  });
});
