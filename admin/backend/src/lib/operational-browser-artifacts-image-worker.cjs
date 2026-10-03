'use strict';
// Fixed private stdin/stdout protocol; only an already-normalized 8-bit RGBA PNG.
// Run only behind the reviewed decoder isolation wrapper. No paths/URLs/logging.
const zlib = require('node:zlib');
const MAX = 8388608;
const bad = () => { throw new Error('Invalid private screenshot'); };
const table = Array.from({length:256},(_,i)=> { let c=i;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0; });
function crc(bytes) { let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0; }
function chunk(type,data) {
  const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length,0);out.write(type,4,'ascii');data.copy(out,8);
  out.writeUInt32BE(crc(out.subarray(4,out.length-4)),out.length-4);return out;
}
function parsePng(bytes) {
  if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))bad();
  let p=8,width,height,ended=false;const idat=[];
  while(p<bytes.length) {
    if(p+12>bytes.length)bad();const size=bytes.readUInt32BE(p),type=bytes.toString('ascii',p+4,p+8);
    if(size>MAX || p+size+12>bytes.length || crc(bytes.subarray(p+4,p+8+size))!==bytes.readUInt32BE(p+8+size))bad();
    const value=bytes.subarray(p+8,p+8+size);
    if(type==='IHDR') {
      if(p!==8 || size!==13 || width)bad();width=value.readUInt32BE(0);height=value.readUInt32BE(4);
      if(width<1 || height<1 || width>8192 || height>8192 || width*height>16000000 ||
        !value.subarray(8).equals(Buffer.from([8,6,0,0,0])))bad();
    } else if(type==='IDAT') { if(!width || ended)bad();idat.push(value); }
    else if(type==='IEND') { if(!idat.length || size || p+12!==bytes.length)bad();ended=true; }
    else bad(); // normalization must already have removed metadata/other chunks
    p+=size+12;
  }
  if(!ended)bad();const row=width*4,compressed=Buffer.concat(idat),result=zlib.inflateSync(compressed,{maxOutputLength:(row+1)*height,info:true});
  if(result.buffer.length!==(row+1)*height || result.engine.bytesWritten!==compressed.length)bad();
  const pixels=Buffer.alloc(row*height),packed=result.buffer;
  const paeth=(a,b,c)=> { const p=a+b-c,da=Math.abs(p-a),db=Math.abs(p-b),dc=Math.abs(p-c);return da<=db&&da<=dc?a:db<=dc?b:c; };
  for(let y=0;y<height;y++) {
    const filter=packed[y*(row+1)];if(filter>4)bad();
    for(let x=0;x<row;x++) {
      const i=y*row+x,raw=packed[y*(row+1)+1+x],left=x>=4?pixels[i-4]:0,up=y?pixels[i-row]:0,diag=y&&x>=4?pixels[i-row-4]:0;
      pixels[i]=(raw+(filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):filter===4?paeth(left,up,diag):0))&255;
    }
  }
  return {width,height,pixels};
}
function redact(bytes,rectangles) {
  const {width,height,pixels}=parsePng(bytes);
  if(!Array.isArray(rectangles) || rectangles.length>32)bad();
  for(const r of rectangles) {
    if(!r || Object.keys(r).sort().join(',')!=='height,width,x,y' || !Object.values(r).every(Number.isInteger) ||
      r.x<0 || r.y<0 || r.width<1 || r.height<1 || r.x+r.width>width || r.y+r.height>height)bad();
    for(let y=r.y;y<r.y+r.height;y++)for(let x=r.x;x<r.x+r.width;x++){const p=(y*width+x)*4;pixels.fill(0,p,p+3);pixels[p+3]=255;}
  }
  const packed=Buffer.alloc((width*4+1)*height);
  for(let y=0;y<height;y++)pixels.copy(packed,y*(width*4+1)+1,y*width*4,(y+1)*width*4);
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);Buffer.from([8,6,0,0,0]).copy(ihdr,8);
  const clean=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(packed,{level:9})),chunk('IEND',Buffer.alloc(0))]);
  if(clean.length>MAX)bad();return {width,height,bytes:clean};
}
const chunks=[];let total=0;
process.stdin.on('data',b=> {total+=b.length;if(total>MAX+4096){process.exitCode=1;process.stdin.destroy();}else chunks.push(b);});
process.stdin.on('end',()=> {
  try {
    const input=Buffer.concat(chunks),p=input.indexOf(10);if(p<1 || p>4095)bad();
    const header=JSON.parse(input.subarray(0,p));if(Object.keys(header).join(',')!=='rectangles')bad();
    const result=redact(input.subarray(p+1),header.rectangles);
    process.stdout.write(JSON.stringify({width:result.width,height:result.height})+'\n');process.stdout.end(result.bytes);
  } catch {process.exitCode=1;}
});
