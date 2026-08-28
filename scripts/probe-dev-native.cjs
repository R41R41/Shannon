// No bot startup, credentials, network or database access.
const assert = require('node:assert/strict');
const sodium = require('sodium-native');
const key=Buffer.alloc(sodium.crypto_secretbox_KEYBYTES),nonce=Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES);
sodium.randombytes_buf(key);sodium.randombytes_buf(nonce);
const msg=Buffer.from('Shannon offline native verification'),cipher=Buffer.alloc(msg.length+sodium.crypto_secretbox_MACBYTES),plain=Buffer.alloc(msg.length);
sodium.crypto_secretbox_easy(cipher,msg,nonce,key);assert(sodium.crypto_secretbox_open_easy(plain,cipher,nonce,key));assert.deepEqual(plain,msg);
const {OpusEncoder}=require('@discordjs/opus');const encoder=new OpusEncoder(48000,2);const packet=encoder.encode(Buffer.alloc(960*2*2),960);assert(encoder.decode(packet).length>0);
assert(require('canvas').createCanvas(2,2).toBuffer('image/png').length>0);
for(const name of ['@discordjs/voice','@snazzah/davey','mineflayer'])require(name);
console.log(JSON.stringify({node:process.version,sodiumRoundTrip:true,opusRoundTrip:true,canvas:true,voiceAndMineflayerImports:true}));
