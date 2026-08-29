import type { mongo } from 'mongoose';
import type { RadarCandidateSource,RadarDeliveryReceiptPort } from './radarDiscovery.js';
type Receipt={_id:string;schemaVersion:1;owner:string;source:RadarCandidateSource;reservedAt:number};
const writeConcern={w:'majority' as const,j:true,wtimeoutMS:5000};const OWNER=/^line:[a-f0-9]{64}$/,KEY=/^[a-f0-9]{64}$/;
export const RADAR_DELIVERY_RECEIPT_COLLECTION='radardeliveryreceipts';
export const RADAR_DELIVERY_RECEIPT_VALIDATOR=Object.freeze({$jsonSchema:{bsonType:'object',required:['_id','schemaVersion','owner','source','reservedAt'],additionalProperties:false,
  properties:{_id:{bsonType:'string',pattern:'^[a-f0-9]{64}$'},schemaVersion:{bsonType:'int',enum:[1]},owner:{bsonType:'string',pattern:'^line:[a-f0-9]{64}$'},
    source:{bsonType:'string',enum:['youtube','x','web','weather','calendar','notion','gmail','discord']},reservedAt:{bsonType:['long','double'],minimum:1}}}});
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export async function radarDeliveryReceiptDatabaseReady(db:mongo.Db){const rows=await db.listCollections({name:RADAR_DELIVERY_RECEIPT_COLLECTION},{nameOnly:false}).toArray();const options=rows[0]?.options;
  if(rows.length!==1||options?.validationLevel!=='strict'||options?.validationAction!=='error'||canonical(options.validator)!==canonical(RADAR_DELIVERY_RECEIPT_VALIDATOR))throw new Error('RADAR_RECEIPT_FENCE_REQUIRED');}
/** Permanent insert-only identities. Raw external IDs, titles, URLs, search queries, and OAuth data are not stored. */
export class MongoRadarDeliveryReceipts implements RadarDeliveryReceiptPort{
  private readonly collection:mongo.Collection<Receipt>;constructor(db:mongo.Db){this.collection=db.collection<Receipt>(RADAR_DELIVERY_RECEIPT_COLLECTION);}
  async existing(owner:string,keys:readonly string[],signal:AbortSignal){if(!OWNER.test(owner)||keys.length>60||keys.some(k=>!KEY.test(k))||new Set(keys).size!==keys.length)throw new Error('RADAR_RECEIPT_INVALID');
    signal.throwIfAborted();if(!keys.length)return new Set<string>();const rows=await this.collection.find({_id:{$in:[...keys]},owner},{projection:{_id:1},maxTimeMS:5000,readPreference:'primary'}).toArray();signal.throwIfAborted();return new Set(rows.map(row=>row._id));}
  async reserve(owner:string,key:string,source:RadarCandidateSource,at:number){if(!OWNER.test(owner)||!KEY.test(key)||!['youtube','x','web','weather','calendar','notion','gmail','discord'].includes(source)||!Number.isSafeInteger(at)||at<1)throw new Error('RADAR_RECEIPT_INVALID');
    try{await this.collection.insertOne({_id:key,schemaVersion:1,owner,source,reservedAt:at},{writeConcern});return true;}catch(error){if((error as{code?:number}).code===11000)return false;throw error;}}
}
