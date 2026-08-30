import { describe,expect,it,vi } from 'vitest';
import { MongoRadarDeliveryReceipts,RADAR_DELIVERY_RECEIPT_COLLECTION,RADAR_DELIVERY_RECEIPT_VALIDATOR,radarDeliveryReceiptDatabaseReady } from '../../src/services/radar/mongoRadarDeliveryReceipts.js';
const owner='line:'+'a'.repeat(64),key='b'.repeat(64);
describe('Mongo Radar delivery receipts',()=>{
  it('stores only permanent hashed identity with source and majority journal concern',async()=>{const find=vi.fn(()=>({toArray:async()=>[{_id:key}]})),insertOne=vi.fn(async()=>({acknowledged:true}));
    const receipts=new MongoRadarDeliveryReceipts({collection:()=>({find,insertOne})} as any);expect(await receipts.existing(owner,[key],new AbortController().signal)).toEqual(new Set([key]));
    expect(await receipts.reserve(owner,key,'youtube',123)).toBe(true);expect(insertOne).toHaveBeenCalledWith({_id:key,schemaVersion:1,owner,source:'youtube',reservedAt:123},{writeConcern:{w:'majority',j:true,wtimeoutMS:5000}});
    expect(JSON.stringify(insertOne.mock.calls)).not.toMatch(/title|url|externalId/);});
  it('requires an exact strict validator without modifying the database',async()=>{const options:any={validator:RADAR_DELIVERY_RECEIPT_VALIDATOR,validationLevel:'strict',validationAction:'error'};
    const db={collection:vi.fn(),listCollections:()=>({toArray:async()=>[{name:RADAR_DELIVERY_RECEIPT_COLLECTION,options}]})};await radarDeliveryReceiptDatabaseReady(db as any);expect(db.collection).not.toHaveBeenCalled();
    options.validationLevel='moderate';await expect(radarDeliveryReceiptDatabaseReady(db as any)).rejects.toThrow('RADAR_RECEIPT_FENCE_REQUIRED');});
});
