const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const elements=new Map();
function el(s){if(!elements.has(s))elements.set(s,{innerHTML:'',value:'',textContent:'',style:{},dataset:{},clientWidth:600,classList:{toggle(){},remove(){},contains(){return false}},setAttribute(){},removeAttribute(){},pause(){},focus(){},click(){},remove(){},getContext(){return {scale(){},beginPath(){},moveTo(){},lineTo(){},stroke(){}}}});return elements.get(s)}
class Audio{constructor(){this.currentTime=0;this.destination={}}createBuffer(ch,len,sr){let arrays=Array.from({length:ch},()=>new Float32Array(len));return {numberOfChannels:ch,length:len,sampleRate:sr,duration:len/sr,getChannelData:c=>arrays[c]}}}
const sandbox={console,Blob,URL,Uint8Array,DataView,ArrayBuffer,structuredClone,setTimeout:()=>0,clearTimeout(){},requestAnimationFrame(){},devicePixelRatio:1,window:{AudioContext:Audio,addEventListener(){},print(){}},document:{querySelector:s=>s==='.toast'||s==='.modal-backdrop'?null:el(s),querySelectorAll:()=>[],createElement:()=>el('created'),body:{append(){}},addEventListener(){}}};
vm.createContext(sandbox);vm.runInContext(fs.readFileSync('public/studio/app.js','utf8'),sandbox);
const run=s=>vm.runInContext(s,sandbox);
(async()=>{
assert.equal(run('buffer().duration'),18);assert.equal(run('state.notes.length'),7);
run('state.selection=[2,5];edit("cut")');assert.equal(run('item().edited.duration'),15);assert.equal(run('item().original.duration'),18);assert.equal(run('history.length'),1);
run('$("#undo").onclick()');assert.equal(run('buffer().duration'),18);run('$("#redo").onclick()');assert.equal(run('buffer().duration'),15);
run('state.selection=[1,4];edit("trim")');assert.equal(run('buffer().duration'),3);assert.equal(run('item().original.duration'),18);
let blob=run('wav(buffer())'),v=new DataView(await blob.arrayBuffer());assert.equal(v.getUint32(24,true),22050);assert.equal(v.getUint32(40,true),3*22050*2);assert.equal(blob.size,44+3*22050*2);
let midi=run('midi()');assert.equal(Buffer.from(midi.slice(0,4)).toString(),'MThd');assert.equal(midi[13],224);assert.equal((midi[20]<<8)+midi[21],midi.length-22);
assert.match(run('xml()'),/<score-partwise version="4.0">/);assert.match(run('xml()'),/<divisions>2<\/divisions>/);
run('state.name="<Test & titel>"');assert.match(run('xml()'),/&lt;Test &amp; titel&gt;/);
run('state.pitch=12;playing=true;started=0;offset=0;ctx.currentTime=1');assert.equal(run('position()'),2);run('playing=false');
assert.equal(run('srtTime(3723.456)'), '01:02:03,456');assert.equal(run('notesDuration()'),4.8);
console.log('PASS: demo, trim, cut, original preservation, undo/redo, WAV header and samples, MIDI structure, MusicXML metadata/escaping, pitch timing, SRT timing.');
})().catch(e=>{console.error(e);process.exitCode=1});
