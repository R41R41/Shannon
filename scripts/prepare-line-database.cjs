'use strict';
// Explicit setup for a NEW standalone database. Refuses any existing collection; never alters legacy DBs.
const path = require('node:path'); const {pathToFileURL} = require('node:url');
async function main() {
  const root=path.resolve(__dirname,'..'), target=process.argv[2];
  if(root!=='/home/azureuser/Shannon-dev'||process.argv.length!==4||process.argv[3]!=='--new-empty-database'||!['dev','prod'].includes(target))throw Error();
  const {mongo}=require('mongoose');const name=`shannon_line_${target}`;
  const client=new mongo.MongoClient(`mongodb://127.0.0.1:27017/${name}`,{serverSelectionTimeoutMS:5000});
  try {
    await client.connect(); const db=client.db(name);
    if((await db.listCollections().toArray()).length)throw Error();
    const {CATALOG_VALIDATOR,RADAR_DELIVERY_RECEIPT_VALIDATOR}=await import(pathToFileURL(path.join(root,'backend/dist-line/database-schema.mjs')).href);
    await db.createCollection('radarpersonalcatalogs',{validator:CATALOG_VALIDATOR,validationLevel:'strict',validationAction:'error',writeConcern:{w:'majority',j:true}});
    await db.createCollection('radardeliveryreceipts',{validator:RADAR_DELIVERY_RECEIPT_VALIDATOR,validationLevel:'strict',validationAction:'error',writeConcern:{w:'majority',j:true}});
    await db.createCollection('linechannelledgers',{writeConcern:{w:'majority',j:true}});
    console.log(JSON.stringify({created:true,database:name,existingDataChanged:false}));
  } finally {await client.close();}
}
main().catch(()=>{console.error('LINE_DATABASE_PREPARATION_REFUSED');process.exitCode=1;});
