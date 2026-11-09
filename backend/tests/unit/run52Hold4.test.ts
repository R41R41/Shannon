import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import { floorlessAt, go, waterFaceBelow } from '../../src/services/minebot/utils/primitives/go.js';

// Run52 hold4: the dry feet/head cells were stone, but the cell under the requested feet was water.
// waterOk permits swimming in water; it cannot give the pathfinder a standing node above the water.
const shore: Ground = (x,y,z) => {
  if (Math.abs(x)>8 || Math.abs(z)>8) return null;
  if (x===3 && z===0 && y===63) return 'water';
  if (x===3 && z===0 && (y===64 || y===65)) return 'stone';
  return y<64 ? 'stone' : 'air';
};
const place={x:3,y:64,z:0};
const rule={names:new Set(['stone'])};
beforeEach(()=>vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date','performance']}));
afterEach(()=>vi.useRealTimers());
async function drive<T>(sim:Sim,p:Promise<T>):Promise<T> {
  let done=false;p.then(()=>{done=true;},()=>{done=true;});
  for(let ms=0;ms<10_000&&!done;ms+=50){sim.tick();await vi.advanceTimersByTimeAsync(50);}
  if(!done)throw new Error('hand did not settle');
  return p;
}
describe('run52 hold4: a dry exact goal above water is not a swimming destination',()=>{
  it('returns no_floor before searching or digging, even with waterOk and the requested stone allowed',async()=>{
    const sim=makeSim(shore,{start:[0.5,64,0.5],items:[{name:'iron_pickaxe',count:1}]});
    const search=vi.spyOn(sim.bot.pathfinder,'getPathFromTo');
    const p=go({bot:sim.bot,stop:new AbortController().signal,deadline:Date.now()+10_000,facing:'east',base:{x:0,y:64,z:0}} as never,
      {goals:[place],canDig:['stone'],waterOk:true,range:0.5,searchMs:50,seconds:2});
    const out=await drive(sim,p);
    expect(out.reason).toBe('no_floor');expect(out.text).toContain('water');
    expect(search).not.toHaveBeenCalled();expect(sim.bot.dugBlocks).toEqual([]);
  });
  it('leaves a water-filled feet cell to the swimmer, and a dry cell to a permitted scaffold',()=>{
    const wet=makeSim((x,y,z)=>x===3&&z===0&&y===64?'water':shore(x,y,z));
    expect(floorlessAt(wet.bot,place,rule,false)).toBeNull();
    const dry=makeSim(shore);
    expect(floorlessAt(dry.bot,place,rule,true)).toBeNull();
    const solid=makeSim((x,y,z)=>x===3&&z===0&&y===63?'stone':shore(x,y,z));
    expect(floorlessAt(solid.bot,place,rule,false)).toBeNull();
  });
  it('keeps unreadable and climbable destination cells unknown or reachable',()=>{
    for(const cell of [null,'ladder','vine','scaffolding']){
      const sim=makeSim((x,y,z)=>x===3&&z===0&&y===64?cell:shore(x,y,z));
      expect(floorlessAt(sim.bot,place,rule,false)).toBeNull();
    }
  });
  it('refuses the exact saved run52 target before searching in the actual recorded terrain',async()=>{
    const fixture=JSON.parse(fs.readFileSync(new URL('../fixtures/run52-hold4-go.json',import.meta.url),'utf8'));
    const cells=fixture.runs.flatMap(([i,n]:number[])=>Array(n).fill(fixture.palette[i]));
    const sim=makeSim((x,y,z)=>{
      const [ox,oy,oz]=fixture.origin,[sx,sy,sz]=fixture.size;const dx=x-ox,dy=y-oy,dz=z-oz;
      return dx<0||dy<0||dz<0||dx>=sx||dy>=sy||dz>=sz?null:cells[(dy*sz+dz)*sx+dx];
    },{start:fixture.feet,items:[{name:'iron_pickaxe',count:1}]});
    const search=vi.spyOn(sim.bot.pathfinder,'getPathFromTo');
    const out=await drive(sim,go({bot:sim.bot,stop:new AbortController().signal,deadline:Date.now()+10_000,facing:'north',base:{x:-502,y:48,z:-175}} as never,
      {goals:[fixture.target],waterOk:true,canDig:['stone','dirt'],maxDig:40,seconds:60}));
    expect(out.reason).toBe('no_floor');expect(out.text).toContain('水面の上');
    expect(search).not.toHaveBeenCalled();expect(sim.bot.dugBlocks).toEqual([]);
  });
});

// end1109s02 S9 (the sea, 127-142 s): a place on the sea's face with waterOk was refused three times; it is the water cell under it now.
const sea: Ground = (x,y,z) => {
  if (Math.abs(x)>8 || Math.abs(z)>8) return null;
  if (x>=2 && y>=58 && y<=62) return x===4 && z===0 ? (y===62 ? 'kelp' : 'kelp_plant') : 'water';
  return y<64 && x<2 ? 'stone' : y<58 ? 'stone' : 'air';
};
describe('end1109s02: a place on the water face is the water under it',()=>{
  it('names the water or kelp cell under open air, and nothing for a dry or rock-filled place',()=>{
    const sim=makeSim(sea);
    expect(waterFaceBelow(sim.bot,{x:3,y:63,z:0})).toBe(62);
    expect(waterFaceBelow(sim.bot,{x:4,y:63,z:0})).toBe(62);
    expect(waterFaceBelow(sim.bot,{x:0,y:64,z:0})).toBeNull();
    expect(waterFaceBelow(sim.bot,{x:3,y:62,z:0})).toBeNull();
    const rock=makeSim(shore);
    expect(waterFaceBelow(rock.bot,place)).toBeNull();
    expect(floorlessAt(sim.bot,{x:4,y:62,z:0},rule,false)).toBeNull();
  });
  it('searches toward the sunk place instead of refusing it as no_floor',async()=>{
    const sim=makeSim(sea,{start:[0.5,64,0.5],items:[]});
    const search=vi.spyOn(sim.bot.pathfinder,'getPathFromTo');
    const out=await drive(sim,go({bot:sim.bot,stop:new AbortController().signal,deadline:Date.now()+10_000,facing:'east',base:{x:0,y:64,z:0}} as never,
      {goals:[{x:4,y:63,z:0}],waterOk:true,maxDig:0,maxPlace:0,searchMs:50,seconds:2}));
    expect(out.reason).not.toBe('no_floor');
    expect(search).toHaveBeenCalled();
    if(out.text)expect(out.text).not.toContain('水面の上には立てない');
  });
});
