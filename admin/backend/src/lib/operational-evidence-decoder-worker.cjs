'use strict';
// Fixed stdin/stdout protocol. No user filenames, URLs, credentials or logging.
const { PNG }=require('pngjs');
const jpeg=require('jpeg-js');
const zlib=require('node:zlib');
const crc=require('pngjs/lib/crc');
const MAX=8388608;
const reject=()=>{throw new Error('Invalid image');};
function dimensions(w,h) { if(!w||!h||w>8192||h>8192||w*h>16000000) reject(); }
function pngShape(b) {
  let p=8,ihdr=false,idat=false,end=false,rowBytes=0,rows=0;const compressed=[];
  while(p<b.length) {
    if(p+12>b.length) reject();
    const n=b.readUInt32BE(p),type=b.toString('ascii',p+4,p+8);
    if(n>MAX || p+12+n>b.length || !/^[A-Za-z]{4}$/.test(type)) reject();
    if((crc.crc32(b.subarray(p+4,p+8+n))>>>0)!==b.readUInt32BE(p+8+n)) reject();
    if(!ihdr && type!=='IHDR') reject();
    if(['acTL','fcTL','fdAT'].includes(type)) reject();
    if(type==='IHDR') {
      if(ihdr||n!==13) reject(); ihdr=true; dimensions(b.readUInt32BE(p+8),b.readUInt32BE(p+12));
      // Deliberately bounded supported PNG subset: 8-bit, noninterlaced.
      if(b[p+16]!==8 || ![0,2,3,4,6].includes(b[p+17]) || b[p+18]!==0 || b[p+19]!==0 || b[p+20]!==0) reject();
      rowBytes=b.readUInt32BE(p+8)*({0:1,2:3,3:1,4:2,6:4}[b[p+17]])+1;rows=b.readUInt32BE(p+12);
    }
    if(type==='IDAT') {idat=true;compressed.push(b.subarray(p+8,p+8+n));}
    if(type==='IEND') { if(n!==0||!idat||p+12!==b.length) reject(); end=true; }
    if(!['IHDR','PLTE','IDAT','IEND','tRNS','gAMA','cHRM','sRGB','pHYs','tEXt','zTXt','iTXt','iCCP','eXIf','bKGD','sBIT','tIME','hIST','sPLT'].includes(type)) reject();
    p+=n+12;
  }
  if(!end) reject();
  const packed=Buffer.concat(compressed),decoded=zlib.inflateSync(packed,{maxOutputLength:rowBytes*rows,info:true});
  if(decoded.buffer.length!==rowBytes*rows || decoded.engine.bytesWritten!==packed.length) reject();
}
function jpegShape(b) {
  let p=2,frame=false,scan=false,end=false;
  while(p<b.length) {
    if(b[p++]!==255) reject();
    while(b[p]===255) p++;
    const m=b[p++];
    if(m===217) { if(!scan||p!==b.length) reject();end=true;break; }
    if(m===216||m===0||m===1 || (m>=208&&m<=215)) reject();
    if(p+2>b.length) reject();
    const n=b.readUInt16BE(p);if(n<2||p+n>b.length) reject();
    if([192,193,194].includes(m)) {
      if(frame||n<8 || b[p+2]!==8) reject();frame=true;
      dimensions(b.readUInt16BE(p+5),b.readUInt16BE(p+3));
    } else if(m>=195&&m<=207 && ![196,200,204].includes(m)) reject();
    // Reject multi-picture JPEG containers (MPF) and embedded secondary images.
    if(m===226 && b.toString('ascii',p+2,p+5)==='MPF') reject();
    p+=n;
    if(m===218) {
      if(!frame) reject(); scan=true;
      while(p<b.length) {
        if(b[p]!==255) {p++;continue;}
        if(b[p+1]===0 || (b[p+1]>=208&&b[p+1]<=215)) {p+=2;continue;}
        break;
      }
    }
  }
  if(!end||!frame) reject();
}
const chunks=[];let total=0;
process.stdin.on('data',b=>{total+=b.length;if(total>MAX){process.exitCode=1;process.stdin.destroy();}else chunks.push(b);});
process.stdin.on('end',()=>{
  try {
    const b=Buffer.concat(chunks);let decoded,mime;
    if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
      pngShape(b);mime='image/png';decoded=PNG.sync.read(b,{checkCRC:true,skipRescale:true});
    } else if(b[0]===255&&b[1]===216) {
      jpegShape(b);mime='image/jpeg';decoded=jpeg.decode(b,{useTArray:true,tolerantDecoding:false,maxResolutionInMP:16,maxMemoryUsageInMB:192});
    } else reject();
    dimensions(decoded.width,decoded.height);
    // Construct from pixels only: never propagate metadata, gamma or EXIF.
    const clean=PNG.sync.write({width:decoded.width,height:decoded.height,data:Buffer.from(decoded.data)},
      {colorType:6,inputColorType:6,bitDepth:8,deflateLevel:9});
    if(clean.length>MAX) reject();
    const header=Buffer.from(JSON.stringify({width:decoded.width,height:decoded.height,mime})+'\n');
    process.stdout.write(header);process.stdout.end(clean);
  } catch { process.exitCode=1; }
});
