import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { Vec3 } from 'vec3';
import { makeSim, type Sim } from '../helpers/physicsBody.js';
import { installFloorReflexes, runCover } from '../../src/services/minebot/utils/floorReflexes.js';
import { floorConfig } from '../../src/services/minebot/utils/floorConfig.js';
import { centreInColumn } from '../../src/services/minebot/utils/tunnelWalk.js';
import { installLife } from '../../src/services/minebot/utils/life.js';
import { cancelActiveActions, createMotorPort, executeAction, physicalActionBusy } from '../../src/services/minebot/execution/ActionExecution.js';

// The physics world supplies the authoritative block update; only the wire confirmation is a stand-in here.
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', async original => ({
  ...await original<typeof import('../../src/services/minebot/utils/digBlockVerified.js')>(),
  digBlockVerified: async (bot: any, block: any) => { await bot.dig(block); return {stateId:0,blockName:'air'}; },
}));
await import('../../src/services/minebot/utils/primitives/dig.js');
await import('../../src/services/minebot/utils/tunnelWalk.js');

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });
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
    expect(result.dig).toBe('not_started');
    expect(sim.bot.dugBlocks).toEqual([]);
  });
  it('S2 (lab c1): a fireball knocks the body 1.2 off the dug column during the dig; it walks back over the hole and drops',async()=>{
    const sim=makeSim((_x,y,_z)=>y<64?'dirt':'air',{start:[0.5,64,0.5],digMs:100});
    const dig=sim.bot.dig;
    sim.bot.dig=async(block:any)=>{await dig(block);sim.bot.entity.position.x=1.7;};
    const result=await drive(sim,runCover(sim.bot,sim.bot,{kind:'dig',cell:{x:0,y:63,z:0},detail:'cover dig'}));
    expect(result.success,result.result).toBe(true);
    expect(sim.bot.entity.position.y).toBeCloseTo(63,1);
    expect(Math.floor(sim.bot.entity.position.x)).toBe(0);
    expect(sim.bot.controlState.forward).not.toBe(true);
  });
  it('does not claim a descent if the server leaves the supporting floor in place',async()=>{
    const sim=makeSim((_x,y,_z)=>y<64?'dirt':'air',{start:[0.5,64,0.5],digMs:100,ghost:(_x,y,_z)=>y===63?'dirt':undefined});
    const result=await drive(sim,runCover(sim.bot,sim.bot,{kind:'dig',cell:{x:0,y:63,z:0},detail:'cover dig'}));
    expect(result.success).toBe(false);
    expect(result.dig).toBe('did_not_drop');
    expect(sim.bot.entity.position.y).toBeCloseTo(64,1);
  });
});

describe('recorded skeleton knockback: centring and a refused dig are different from a failed descent', () => {
  it('re-aims while the arrow keeps carrying the body sideways, with at most the existing 16 ticks per attempt', async () => {
    // exact-1105a: 4785 ms position; the next 48 ms displacement seeds a physics impulse (not an unrecorded velocity packet).
    const sim=makeSim((_x,y,_z)=>y<200?'stone':'air',{start:[3500.5,200,3500.9650286082156]});
    sim.bot.entity.velocity=new Vec3(-0.21784776902896166,0.2751632790087153,-0.01359094118199896);
    const feet=new Vec3(3500,200,3500), started=Date.now();
    const first=centreInColumn(sim.bot,feet);
    await vi.advanceTimersByTimeAsync(0);
    expect(await drive(sim,first)).toBe('not_centred');
    expect(Date.now()-started).toBeLessThanOrEqual(800);
    // It has turned back toward the selected column, rather than continuing north after the westward knock.
    expect(sim.bot.entity.position.x).toBeGreaterThan(3500);
    expect(sim.bot.dugBlocks).toEqual([]);
    expect(await drive(sim,centreInColumn(sim.bot,feet))).toBeNull();
    expect(Math.max(Math.abs(sim.bot.entity.position.x-3500.5),Math.abs(sim.bot.entity.position.z-3500.5))).toBeLessThanOrEqual(.2);
    expect(sim.control.forward).toBe(false);
    expect(sim.control.sneak).toBe(false);
  });

  it.each(['cancel', 'death', 'respawn', 'dimension', 'same_entity_recovered'])('does not restart steering after %s while the owned aim is pending', async boundary => {
    const sim=makeSim((_x,y,_z)=>y<64?'dirt':'air',{start:[.5,64,.05]});
    const keeper=boundary==='same_entity_recovered'?installLife(sim.bot,{file:`${tmpdir()}/centre-life-${randomUUID()}.json`}):null;
    const steering=vi.spyOn(sim.bot,'setControlState');
    let finishAim!:()=>void;
    sim.bot.lookAt=vi.fn().mockImplementationOnce(()=>new Promise<void>(resolve=>{finishAim=resolve;})).mockResolvedValue(undefined);
    const work=executeAction(sim.bot,'floor-cover',5500,async()=>{
      const why=await centreInColumn(createMotorPort(sim.bot),new Vec3(0,64,0));
      return {success:why===null,result:why??'centred'};
    },{safetyLease:true,priority:250,waitForQuiescence:true});
    await vi.advanceTimersByTimeAsync(0);
    expect(finishAim).toBeTypeOf('function');
    if(boundary==='death') { sim.bot.health=0; sim.bot.emit('death'); }
    else if(boundary==='respawn') sim.bot.entity={...sim.bot.entity,position:new Vec3(.5,64,.05)};
    else if(boundary==='dimension') sim.bot.game.dimension='the_nether';
    else if(boundary==='same_entity_recovered') { sim.bot.health=0; sim.bot.emit('death'); sim.bot.health=20; sim.bot.emit('respawn'); sim.bot.emit('spawn'); }
    else cancelActiveActions(sim.bot,'test-cancel');
    finishAim();
    const result=await drive(sim,work);
    expect(result.success).toBe(false);
    expect(sim.control.forward).toBe(false);
    expect(sim.control.sneak).toBe(false);
    expect(sim.bot.dugBlocks).toEqual([]);
    expect(steering.mock.calls.some(([key,value])=>(key==='forward'||key==='sneak')&&value===true)).toBe(false);
    expect(physicalActionBusy(sim.bot)).toBe(false);
    keeper?.dispose();
  });

  function shotScene(ghost=false) {
    const sim=makeSim((_x,y,_z)=>y<64?'dirt':'air',{
      start:[.5,64,ghost?.5:.05],digMs:100,...(ghost?{ghost:(_x:number,y:number,_z:number)=>y===63?'dirt':undefined}:{}),
    });
    sim.bot.entity.id=1;
    sim.bot._client=new EventEmitter();
    sim.bot.entities[7]={id:7,name:'skeleton',type:'hostile',position:new Vec3(20.5,64,.5),height:1.99,width:.6};
    installFloorReflexes(sim.bot,floorConfig({MINEBOT_FCA_REFLEX_OFF:'retreat,eat'}));
    sim.bot._client.emit('damage_event',{entityId:1,sourceCauseId:8,sourceDirectId:101});
    return sim;
  }

  it('keeps a pre-dig centring refusal retryable, while still counting the attempt against the existing cap', async () => {
    const sim=shotScene();
    sim.bot.emit('physicsTick');
    // No physics motion: the server never centres this first attempt. No block can be removed.
    await vi.advanceTimersByTimeAsync(850);
    expect(sim.bot.floorReflexes.busy).toBeNull();
    expect(sim.bot.floorReflexes.cover).toMatchObject({digs:1});
    expect(sim.bot.floorReflexes.cover.digFailed).not.toBe(true);
    expect(sim.bot.dugBlocks).toEqual([]);
    sim.bot.entity.position.set(.5,64,.5);
    sim.bot.emit('physicsTick');
    for(let t=0;t<3000&&sim.bot.floorReflexes.busy;t+=50){sim.tick();await vi.advanceTimersByTimeAsync(50);}
    expect(sim.bot.dugBlocks).toHaveLength(1);
    expect(sim.bot.entity.position.y).toBeCloseTo(63,1);
    expect(sim.bot.floorReflexes.cover.digs).toBe(2);
    expect(sim.bot.floorReflexes.cover.digFailed).not.toBe(true);
  });

  it('still latches after a confirmed dig that did not lower the body', async () => {
    const sim=shotScene(true);
    sim.bot.emit('physicsTick');
    for(let t=0;t<3000&&sim.bot.floorReflexes.busy;t+=50){sim.tick();await vi.advanceTimersByTimeAsync(50);}
    expect(sim.bot.dugBlocks).toHaveLength(1);
    expect(sim.bot.entity.position.y).toBeCloseTo(64,1);
    expect(sim.bot.floorReflexes.cover.digFailed).toBe(true);
    sim.bot.emit('physicsTick');
    expect(sim.bot.floorReflexes.cover.digs).toBe(1);
    cancelActiveActions(sim.bot,'test-end');
    await vi.advanceTimersByTimeAsync(100);
  });

  it('does not turn retryable pre-dig refusals into extra attempts beyond the existing three', async () => {
    const sim=shotScene();
    for(let n=1;n<=3;n++){
      sim.bot.emit('physicsTick');
      await vi.advanceTimersByTimeAsync(850);
      expect(sim.bot.floorReflexes.cover.digs).toBe(n);
      expect(sim.bot.floorReflexes.cover.digFailed).not.toBe(true);
      expect(sim.bot.floorReflexes.busy).toBeNull();
    }
    sim.bot.emit('physicsTick');
    await vi.advanceTimersByTimeAsync(50);
    expect(sim.bot.floorReflexes.cover.digs).toBe(3);
    expect(sim.bot.dugBlocks).toEqual([]);
    expect(physicalActionBusy(sim.bot)).toBe(false);
  });

  it('keeps stone without a pickaxe a separate tool refusal; it does not pretend that the floor was dug', async () => {
    const sim=makeSim((_x,y,_z)=>y<64?'stone':'air',{start:[.5,64,.5],items:[{name:'wooden_sword',count:1},{name:'cobblestone',count:64}]});
    sim.bot.heldItem=sim.items[0]; sim.bot.heldItem.enchants=[];
    sim.bot.getEquipmentDestSlot=()=>5; sim.bot.game.gameMode='survival';
    createRequire(import.meta.url)('mineflayer/lib/plugins/digging.js')(sim.bot);
    const stone=sim.bot.blockAt(new Vec3(0,63,0));
    expect(sim.bot.digTime(stone)).toBeGreaterThanOrEqual(5000);
    sim.bot.heldItem=null;
    expect(sim.bot.digTime(stone)).toBe(7500);
    const result=await drive(sim,runCover(sim.bot,sim.bot,{kind:'dig',cell:{x:0,y:63,z:0},detail:'recorded kit stone'}));
    expect(result).toMatchObject({success:false,dig:'failed'});
    expect(result.result).toContain('掘る道具が無い');
    expect(sim.bot.dugBlocks).toEqual([]);
    expect(sim.world.nameAt(0,63,0)).toBe('stone');
    sim.bot.entity.id=1; sim.bot._client=new EventEmitter();
    sim.bot.entities[7]={id:7,name:'skeleton',type:'hostile',position:new Vec3(20.5,64,.5),height:1.99,width:.6};
    installFloorReflexes(sim.bot,floorConfig({MINEBOT_FCA_REFLEX_OFF:'retreat,eat'}));
    sim.bot._client.emit('damage_event',{entityId:1,sourceCauseId:8,sourceDirectId:101});
    sim.bot.emit('physicsTick');
    await vi.advanceTimersByTimeAsync(50);
    expect(sim.bot.floorReflexes.cover).toMatchObject({digs:1,digRefused:true});
    expect(sim.bot.floorReflexes.cover.digFailed).not.toBe(true);
    sim.bot.emit('physicsTick');
    expect(sim.bot.floorReflexes.cover.digs).toBe(1);
    expect(sim.bot.dugBlocks).toEqual([]);
    cancelActiveActions(sim.bot,'test-end');
    await vi.advanceTimersByTimeAsync(100);
  });
});
