(function(){

/* ============================================================
   Checklist definition
   item = [key, name, hint, type]   type: doc | info | access
   ============================================================ */
let SECTIONS=[
 {n:1,title:"Pre-LOI Documents",gate:true,items:[
   ["preloi_lives","Past 12 Months Attributed Life Count (Unique Patients)","","doc"],
   ["preloi_visits","12 Month Visit Count","","doc"],
   ["preloi_pnl","P&L Information","","doc"],
   ["preloi_payor","Payor Mix Documentation","","doc"],
 ]},
 {n:1,title:"Personal Information",items:[
   ["personal","Full Name, DOB, Address, Phone, Personal Email","Core identity details","info"],
   ["birthplace","City, State & Country of Birth","","info"],
   ["dl","Driver's License","Color copy","doc"],
   ["ssn","Social Security Card / SSN","Copy of card or number","doc"],
   ["headshot","Color Headshot","Digital, passport-size","doc"],
   ["citizenship","Proof of Citizenship","Passport or birth certificate","doc"],
   ["npi","NPI #","National Provider Identifier","info"],
   ["languages","Languages Spoken Fluently","","info"],
 ]},
 {n:2,title:"Education & Training",items:[
   ["diploma","Medical / Practitioner Diploma","Bachelor & Master's if applicable","doc"],
   ["internship","Internship","Certificate of completion","doc"],
   ["fellowship","Fellowship","Certificate of completion","doc"],
   ["residency","Residency","Certificate of completion","doc"],
   ["ecfmg","ECFMG Certificate","If applicable","doc"],
   ["usmle","USMLE Number & Exam Date","If applicable","info"],
 ]},
 {n:3,title:"Work History",items:[
   ["cv","Updated CV","Gap-free, dates & addresses in MM/DD/YYYY","doc"],
   ["epic_pc","EPIC Primary Care Employment","Include start date","info"],
   ["gaps","Employment Gaps > 3 Months","List any gaps over 3 months","info"],
   ["other_loc","Other Practice Locations","EPIC-approved locations, if applicable","info"],
   ["archived_loc","Archived / Rejected Locations","","info"],
 ]},
 {n:4,title:"Licenses & Certificates",items:[
   ["mi_license","Michigan Physician/Practitioner License","State of Michigan","doc"],
   ["mi_cds","Michigan Controlled Substance Registration (CDS)","MD, DO, PA","doc"],
   ["cds_deleg","Delegation of CDS Letter","NP / PA","doc"],
   ["dea","DEA License","","doc"],
   ["bls_acls","BLS / ACLS Certificates","If applicable","doc"],
   ["board","Board Certification","Board name & certification date","doc"],
   ["secondary","Secondary Specialty","If applicable","info"],
   ["cme","CMEs","Credits & MM/YY completed","info"],
   ["skills","Special Skills & Training","Populations, conditions, methods, tools","info"],
   ["other_cert","Other Certifications","QASP, CPR, ALSO, CoreC, ATLS, NALS, NRP, PALS","doc"],
 ]},
 {n:5,title:"Malpractice / Liability Insurance",items:[
   ["liability","Current & Previous Liability Insurance","Include tail coverage if applicable","doc"],
   ["claims","Malpractice Claims Information","If applicable","info"],
 ]},
 {n:6,title:"Peer References",items:[
   ["references","4 Peer References","≥3 in your specialty, not in our practice","doc"],
 ]},
 {n:7,title:"User IDs & Passwords",items:[
   ["caqh","CAQH","888-599-1771","info"],
   ["pecos","PECOS (Medicare)","866-484-8049","info"],
   ["nppes","NPPES","","info"],
   ["champs","CHAMPS (Medicaid)","","info"],
 ]},
 {n:8,title:"Medical Documentation",items:[
   ["flu","Proof of Current Flu Vaccination","Can be scheduled at our office","doc"],
   ["tb","Proof of Current TB Test","Can be scheduled at our office","doc"],
   ["immun","Immunizations","","doc"],
 ]},
 {n:9,title:"Facility / Hospital Affiliations",items:[
   ["affiliations","Affiliations (Current & Prior)","","info"],
   ["denied_aff","Denied Affiliations","","info"],
 ]},
 {n:10,title:"Physician Web Access",items:[
   ["sjh","SJH — St. John Hospital","","access"],
   ["dmc","DMC — Detroit Medical Center","","access"],
   ["wbh","WBH — William Beaumont Hospital","","access"],
   ["hfh","HFH — Henry Ford Hospital","","access"],
   ["maps","MAPS — MI Automated Prescription System","","access"],
   ["uptodate","UpToDate","","access"],
 ]},
 {n:11,title:"Digital Signature",items:[
   ["signature","Digital Signature Document","Sign a blank sheet & email to HR/Credentialing","doc"],
 ]},
 {n:12,title:"Practice Location & Hours",items:[
   ["practice","Practice Location & Hours","","info"],
 ]},
 {n:13,title:"Advanced Practitioners Only",items:[
   ["supervising","Supervising Provider Information","Name, title, phone, email","info"],
   ["collab","Collaborative Agreement","","doc"],
 ]},
];
function itemDef(a){
  if(Array.isArray(a)) return {key:a[0],name:a[1],hint:a[2]||"",type:a[3]||"doc",expiry:a[4]||"none",fields:[]};
  return {key:a.key,name:a.name,hint:a.hint||"",type:a.type||"doc",expiry:a.expiry||"none",expiryDate:a.expiryDate||"",fields:Array.isArray(a.fields)?a.fields:[]};
}
let CHECKLIST=[]; let ALL_KEYS=[]; let SEC_OF={}; let EXPIRY_OF={};
function rebuildCatalog(){
  CHECKLIST=SECTIONS.map((s,idx)=>({n:idx+1,id:s.id||("sec"+(idx+1)),title:s.title,gate:!!s.gate,items:s.items.map(itemDef)}));
  ALL_KEYS=[]; SEC_OF={}; EXPIRY_OF={};
  CHECKLIST.forEach(s=>s.items.forEach(i=>{ALL_KEYS.push(i);SEC_OF[i.key]=s.n;EXPIRY_OF[i.key]=i.expiry||"none";}));
}
rebuildCatalog();
// Replace the catalog with the admin-managed one fetched from the backend.
function setCatalog(sections){ if(sections&&sections.length){ SECTIONS=sections; rebuildCatalog(); } }

function docState(over){
  const d={};
  ALL_KEYS.forEach(i=>{
    const o=over[i.key]||{};
    d[i.key]={status:o.status||"missing", file:o.file||"", value:o.value||"", access:o.access||"",
      updated:o.updated||"", updatedIso:o.updatedIso||"", note:o.note||"", notes:o.notes||[], notif:o.notif||{physician:false,team:false}, expiresAt:o.expiresAt||"", files:o.files||[], fieldValues:o.fieldValues||{}, fieldMeta:o.fieldMeta||{}};
  });
  return d;
}

/* ============================================================
   State
   ============================================================ */
const state={
  role:"guest", otherOnline:false,
  view:"landing", physTab:"checklist",
  teamView:"roster", selectedId:null, meId:null,
  authStep:"role", authRole:"physician", authMode:"login",
  collapsed:{}, drawer:null, fileIdx:0, fileZoom:1,
  rosterFilter:null, detailFilter:null, activating:false,
  physicians:[], source:"providers",
};

/* ---------- helpers ---------- */
const $=s=>document.querySelector(s);
let app=null;
function me(){return state.physicians.find(p=>p.id===state.meId);}
function sel(){return state.physicians.find(p=>p.id===state.selectedId);}
function internalMode(){return state.source==="internal";}
function audience(){return internalMode()?{singular:"employee",plural:"employees",title:"Internal Credentialing",intro:"Continuously track employee credentialing documents.",all:"All employees",active:"Active employees",empty:"No employees yet.",search:"Search employees…",person:"Employee"}:{singular:"physician",plural:"physicians",title:"Credentialing dashboard",intro:"Every physician profile and document in one place.",all:"All physicians",active:"Active physicians",empty:"No physicians yet. Physician profiles appear here after they sign up.",search:"Search physicians…",person:"Physician"};}
function initialsOf(s){return (String(s||"U").split(/[\s@._-]+/).filter(Boolean).map(x=>x[0]).join("")||"U").slice(0,2).toUpperCase();}
function teamName(){return (state.identity&&state.identity.displayName)||"Credentialing team";}
function activeP(){return state.role==="team"?sel():me();}
// Escapes BOTH quote characters: values that reach an attribute context (a
// title=, a data-*, an inline style) can break out with a single quote just as
// easily as a double, and user-set names/notes flow into those attributes.
function esc(s){return (s==null?"":String(s)).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function cap(s){return s.charAt(0).toUpperCase()+s.slice(1);}
function nowStr(){return "Jul 16 · just now";}

const STATUS={
  approved:{label:"Approved",cls:"b-approved"},
  pending:{label:"Pending review",cls:"b-pending"},
  attention:{label:"Needs attention",cls:"b-attention"},
  missing:{label:"Not provided",cls:"b-missing"},
};
function badge(st){const s=STATUS[st]||STATUS.missing;return `<span class="badge ${s.cls}">${s.label}</span>`;}
function itemBadge(def,d){
  if(def.type==="access"){
    if(d.status!=="approved") return `<span class="badge b-missing">Not answered</span>`;
    return d.access==="yes"?`<span class="badge b-approved">Has access</span>`:`<span class="badge b-missing">No access</span>`;
  }
  return badge(d.status);
}
function completeness(p){
  const total=ALL_KEYS.length;
  const done=ALL_KEYS.filter(i=>p.docs[i.key].status==="approved").length;
  return {done,total,pct:Math.round(done/total*100)};
}
function secProgress(p,sec){
  const keys=sec.items;
  const done=keys.filter(i=>p.docs[i.key].status==="approved").length;
  return {done,total:keys.length,pct:Math.round(done/keys.length*100)};
}
function counts(p){
  const c={approved:0,pending:0,attention:0,missing:0};
  ALL_KEYS.forEach(i=>{c[p.docs[i.key].status]++;});
  return c;
}
function notifCount(p,role){return ALL_KEYS.filter(i=>p.docs[i.key].notif[role]).length;}
function teamNotifTotal(){return state.physicians.reduce((a,p)=>a+notifCount(p,"team"),0);}

/* ---------- section gating (hide later sections until complete/acknowledged) ---------- */
function firstNameOf(s){ return String(s||"").trim().split(/\s+/)[0]||"this provider"; }
// A section counts as complete when every item in it is approved.
function sectionComplete(p,sec){ return sec.items.length>0 && secProgress(p,sec).pct===100; }
// A team member has acknowledged (unlocked) a gated section for this provider.
function sectionAcked(p,sec){ return !!(p&&p.sectionAcks&&sec&&p.sectionAcks[sec.id]); }
// Whether a gate on this section is currently open (so later sections are visible).
function gateOpen(p,sec){ return !sec.gate || sectionComplete(p,sec) || sectionAcked(p,sec); }
// Sections a physician can see: everything up to and including the first gated
// section that is neither complete nor acknowledged (which hides the rest).
function visibleSections(p){
  const out=[];
  for(const s of CHECKLIST){
    out.push(s);
    if(s.gate && !sectionComplete(p,s) && !sectionAcked(p,s)) break;
  }
  return out;
}
// The section a physician is actively working on = first visible incomplete one.
function physCurrentN(p){
  const vis=visibleSections(p);
  for(const s of vis){ if(!sectionComplete(p,s)) return s.n; }
  return vis.length?vis[vis.length-1].n:0;
}
// Collapsed state for a section card. Physicians default to collapsed except the
// section they're currently on; an explicit toggle overrides. Team stays expanded.
function isSecCollapsed(p,sec,teamMode,filterFn){
  if(filterFn) return false;
  const ov=state.collapsed[sec.n];
  if(teamMode) return !!ov;
  if(ov!==undefined) return !!ov;
  return sec.n!==physCurrentN(p);
}

/* ---------- expiry + deal helpers ---------- */
function addYears(iso,y){ const d=new Date(iso); if(isNaN(d)) return null; d.setFullYear(d.getFullYear()+y); return d; }
function fmtDay(d){ return d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}); }
// Format an authorship timestamp: ISO strings become a friendly date/time; other
// strings (demo relative labels) pass through unchanged.
function fmtWhen(at){ if(!at) return ""; if(/^\d{4}-\d{2}-\d{2}T/.test(at)){ const d=new Date(at); if(!isNaN(d)) return d.toLocaleDateString("en-US",{month:"short",day:"numeric"})+", "+d.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}); } return at; }
// Returns {mode,date,state} where state is expired|soon|ok|unset, or null when N/A.
function expiryFor(key,d){
  const mode=EXPIRY_OF[key]||"none";
  if(mode==="none") return null;
  let date=null;
  if(mode==="expires"){ if(d.expiresAt) date=new Date(d.expiresAt); else return {mode,date:null,state:"unset"}; }
  else if(mode==="annual"){ if(d.status==="approved"&&d.updatedIso) date=addYears(d.updatedIso,1); else return null; }
  if(!date||isNaN(date)) return {mode,date:null,state:"unset"};
  const now=Date.now(), t=date.getTime(), soon=30*24*60*60*1000;
  return {mode,date,state:t<now?"expired":(t-now<soon?"soon":"ok")};
}
function expiryBadge(key,d){
  const e=expiryFor(key,d); if(!e) return "";
  const label=e.mode==="annual"?"Review by":"Expires";
  if(e.state==="unset") return `<span class="exp exp-unset">${label}: set date</span>`;
  const cls=e.state==="expired"?"exp-expired":(e.state==="soon"?"exp-soon":"exp-ok");
  const txt=e.state==="expired"?`${e.mode==="annual"?"Review overdue":"Expired"} ${fmtDay(e.date)}`:`${label} ${fmtDay(e.date)}`;
  return `<span class="exp ${cls}">${txt}</span>`;
}
// Count expiry issues for a provider across all documents.
function expiryCounts(p){
  let expired=0, soon=0;
  ALL_KEYS.forEach(i=>{ const e=expiryFor(i.key,p.docs[i.key]); if(e){ if(e.state==="expired")expired++; else if(e.state==="soon")soon++; } });
  return {expired,soon};
}
const DEAL_LABEL={pending:"In pipeline",completed:"Active",cancelled:"Cancelled"};
const DEAL_BADGE={pending:"b-pending",completed:"b-approved",cancelled:"b-attention"};
function dealOf(p){return p.deal||{status:"pending",activeDate:null};}
function isComplete(p){const c=completeness(p);return c.total>0&&c.done>=c.total;}


const ICON={
  logo:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
  file:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  up:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
  mail:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/></svg>',
  chat:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  shield:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/></svg>',
  users:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13A4 4 0 0 1 16 11"/></svg>',
  doc2:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>',
  back:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  chev:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  send:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>',
  arrow:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>',
  bell:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  cal:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  lock:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  zin:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/></svg>',
  zout:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M8 11h6"/></svg>',
};

/* ============================================================
   Toast
   ============================================================ */
function toast(title,body,opts={}){
  const t=document.createElement("div");
  t.className="toast";
  t.innerHTML=`<div class="tic">${opts.icon||ICON.mail}</div><div><div class="tt">${title}</div><div class="tb">${body}</div></div>`;
  $("#toasts").appendChild(t);
  setTimeout(()=>{t.style.transition="opacity .3s";t.style.opacity="0";setTimeout(()=>t.remove(),300);},opts.ms||5400);
}

/* ============================================================
   Router
   ============================================================ */
function setRole(role){
  state.role=role;
  document.querySelectorAll("#roleSeg button").forEach(b=>b.classList.toggle("active",b.dataset.role===role));
  state.drawer=null; $("#modalRoot").innerHTML=""; $("#modalRoot2").innerHTML="";
  if(role==="guest"){state.view="landing";state.authStep="role";}
  else if(role==="physician"){state.view="portal";state.physTab="checklist";}
  else{state.view="team";state.teamView="roster";}
  render();
}
function render(){
  if(state.view==="landing") app.innerHTML=viewLanding();
  else if(state.view==="portal") app.innerHTML=viewPortal();
  else if(state.view==="team") app.innerHTML=viewTeam();
  bind();
  saveNav();
}

/* ============================================================
   Navigation persistence (restore the same spot after refresh)
   ============================================================ */
function navKey(){ return "updoc.nav."+((state.identity&&state.identity.id)||"anon")+"."+(state.source||"providers"); }
function saveNav(){
  if(state.role!=="team"&&state.role!=="physician") return;
  try{
    localStorage.setItem(navKey(),JSON.stringify({
      teamView:state.teamView, physTab:state.physTab,
      selectedId:state.selectedId, detailFilter:state.detailFilter,
      rosterFilter:state.rosterFilter, collapsed:state.collapsed,
      drawer:state.drawer, drawerTab:state.drawerTab,
    }));
  }catch(e){}
}
function restoreNav(){
  try{
    const raw=localStorage.getItem(navKey()); if(!raw) return;
    const d=JSON.parse(raw); if(!d) return;
    if(state.role==="team"){
      if(d.teamView) state.teamView=d.teamView;
      if(d.selectedId) state.selectedId=d.selectedId;
      state.detailFilter=d.detailFilter||null;
      state.rosterFilter=d.rosterFilter||null;
    } else if(state.role==="physician"){
      if(d.physTab) state.physTab=d.physTab;
    }
    if(d.collapsed&&typeof d.collapsed==="object") state.collapsed=d.collapsed;
    state.drawer=d.drawer||null;
    state.drawerTab=d.drawerTab||"preview";
  }catch(e){}
}
// Re-open a document drawer that was open before the refresh, once data is loaded.
function restoreDrawer(){
  if(!state.drawer) return;
  const p=activeP();
  const def=ALL_KEYS.find(i=>i.key===state.drawer);
  if(!p||!p.docs||!p.docs[state.drawer]||!def){ state.drawer=null; return; }
  lockBodyScroll();
  renderDrawer();
}

/* ============================================================
   Landing (split screen + role-first login)
   ============================================================ */
function viewLanding(){
  return `<div class="split">
    <div class="left">
      <div class="glow"></div>
      <div class="brand"><span class="logo">${ICON.logo}</span> Upload&nbsp;Doc</div>
      <h1>Physician credentialing, without the paperwork chase.</h1>
      <p class="lede">One secure portal where physicians submit their credentialing documents, and your team collects, reviews, and follows up — document by document.</p>
      <div class="plist">
        <div class="row"><div class="ic">${ICON.up}</div><div><b>A guided checklist</b><span>Every credentialing item, grouped and tracked with live status.</span></div></div>
        <div class="row"><div class="ic">${ICON.doc2}</div><div><b>Notes on each document</b><span>Questions and requests stay attached to the exact document — no lost threads.</span></div></div>
        <div class="row"><div class="ic">${ICON.mail}</div><div><b>Nothing stalls</b><span>Not logged in? A note is emailed automatically so it still gets seen.</span></div></div>
      </div>
      <div class="foot">Illustrative design prototype · encrypted, role-based, audit-logged.</div>
    </div>
    <div class="right"><div class="authbox">${state.authStep==="role"?authRolePick():authForm()}</div></div>
  </div>`;
}
function authRolePick(){
  return `
    <h2 style="font-size:22px;margin-bottom:4px">Welcome to Upload Doc</h2>
    <p class="muted small" style="margin-bottom:20px">To continue, tell us who you are.</p>
    <div class="rolecards">
      <button class="rolecard phys" data-pick="physician">
        <div class="rc-ic">${ICON.up}</div>
        <div><div class="rc-t">I'm a physician</div><div class="rc-s">Create a profile and upload my credentialing documents</div></div>
        <div class="rc-go">${ICON.arrow}</div>
      </button>
      <button class="rolecard team" data-pick="team">
        <div class="rc-ic">${ICON.users}</div>
        <div><div class="rc-t">I'm on the credentialing team</div><div class="rc-s">Review every physician profile and collect documents</div></div>
        <div class="rc-go">${ICON.arrow}</div>
      </button>
    </div>
    <p class="muted small" style="text-align:center;margin-top:18px">Anyone can sign up for a physician profile.</p>`;
}
function authForm(){
  const r=state.authRole,m=state.authMode;
  const isP=r==="physician";
  return `
    <button class="backlink" data-authstep="role">${ICON.back} Choose a different role</button>
    <div class="roletag">${isP?ICON.up:ICON.users} ${isP?"Physician":"Credentialing team"}</div>
    <h2 style="font-size:21px;margin-bottom:4px">${m==="login"?"Log in":"Create your profile"}</h2>
    <p class="muted small" style="margin-bottom:18px">${m==="login"?"Welcome back.":"It only takes a minute to get started."}</p>
    <div class="tabsplit">
      <button class="${m==="login"?"active":""}" data-authmode="login">Log in</button>
      <button class="${m==="signup"?"active":""}" data-authmode="signup">Sign up</button>
    </div>
    ${m=="signup"?`<div class="field"><label>Full name</label><input placeholder="${isP?"Dr. Jane Smith":"Alex Rivera"}"></div>
      ${isP?`<div class="field"><label>Primary specialty</label><input placeholder="e.g. Internal Medicine"></div>`:""}`:""}
    <div class="field"><label>Email</label><input type="email" placeholder="you@example.com"></div>
    <div class="field"><label>Password</label><input type="password" value="••••••••"></div>
    <button class="btn" style="width:100%;justify-content:center;margin-top:6px" data-authsubmit>${m==="login"?"Log in":"Create profile"} ${ICON.arrow}</button>
    <p class="muted small" style="text-align:center;margin-top:14px">${m==="login"?"New here?":"Already registered?"}
      <a data-authmode="${m==="login"?"signup":"login"}">${m==="login"?"Create a profile":"Log in"}</a></p>`;
}

/* ============================================================
   App header
   ============================================================ */
function appHeader(isTeam){
  let nav,who,bell="";
  if(isTeam){
    nav=`<button class="${state.teamView==='roster'?'active':''}" data-goroster>All physicians</button>
         <button class="${state.teamView==='reports'?'active':''}" data-goreports>Reports</button>`;
    who=`<div class="whoami"><div style="text-align:right"><div style="font-weight:600;color:var(--ink)">${esc(teamName())}</div><div class="small">Credentialing team</div></div><div class="avatar team">${esc(initialsOf(state.identity&&(state.identity.displayName||state.identity.email)))}</div></div>`;
    const n=teamNotifTotal();
    if(n) bell=`<button class="bell" title="${n} document${n>1?'s':''} with new physician notes">${ICON.bell}<span class="cnt">${n}</span></button>`;
  } else {
    const p=me();
    nav=`<button class="${state.physTab==='checklist'?'active':''}" data-tab="checklist">My checklist</button>
         <button class="${state.physTab==='profile'?'active':''}" data-tab="profile">Profile</button>`;
    who=`<div class="whoami"><div style="text-align:right"><div style="font-weight:600;color:var(--ink)">${esc(p.name)}</div><div class="small">${esc(p.specialty)}</div></div><div class="avatar">${p.init}</div></div>`;
    const n=notifCount(p,"physician");
    if(n) bell=`<button class="bell" title="${n} document${n>1?'s':''} need your response">${ICON.bell}<span class="cnt">${n}</span></button>`;
  }
  return `<header class="app">
    <div class="brand"><span class="logo">${ICON.logo}</span> Upload&nbsp;Doc ${isTeam?'<span class="badge b-review" style="margin-left:6px">Team console</span>':''}</div>
    <nav>${nav}</nav><div class="headspace"></div>${bell}${who}
  </header>`;
}

/* ============================================================
   Physician portal
   ============================================================ */
function viewPortal(){
  const p=me();
  const body = state.physTab==="profile" ? physProfile(p) : physChecklist(p);
  return `<div class="wrap">${body}</div>`;
}
function physChecklist(p){
  const c=completeness(p),ct=counts(p),nc=notifCount(p,"physician");
  return `
  <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px">
    <div><h1 style="font-size:24px">Credentialing checklist</h1>
      <p class="muted" style="margin:4px 0 0">Work through each section. Add notes on any document to reach your credentialing coordinator.</p></div>
    <div style="min-width:240px">
      <div class="small muted" style="display:flex;justify-content:space-between;margin-bottom:6px"><span><b>${c.done}</b> of ${c.total} approved</span><b>${c.pct}%</b></div>
      <div class="prog"><i style="width:${c.pct}%"></i></div>
    </div>
  </div>
  ${nc?`<div class="card" style="margin-bottom:16px;border-color:#f2cccc"><div class="card-b" style="display:flex;gap:12px;align-items:center;background:var(--red-100);border-radius:var(--radius);padding:14px 16px">
      <div style="width:34px;height:34px;border-radius:9px;background:#fff;color:var(--red);display:flex;align-items:center;justify-content:center;flex-shrink:0">${ICON.bell}</div>
      <div style="flex:1"><b>${nc} document${nc>1?'s':''} need${nc>1?'':'s'} your response.</b> <span class="muted small">Look for the red dot — open the document to read the note and reply.</span></div>
    </div></div>`:""}
  <div class="small muted" style="margin-bottom:14px">${ct.approved} approved · ${ct.pending} in review · ${ct.attention} needs attention · ${ct.missing} not started</div>
  ${visibleSections(p).map(s=>sectionCard(p,s,false)).join("")}
  ${lockedNotice(p)}`;
}
// Notice shown to a physician when later sections are hidden behind a gate.
function lockedNotice(p){
  const vis=visibleSections(p);
  const hidden=CHECKLIST.length-vis.length;
  if(hidden<=0) return "";
  const gate=vis[vis.length-1];
  return `<div class="card locked-note"><div class="card-b" style="display:flex;gap:12px;align-items:center">
    <div class="lock-ic">${ICON.lock}</div>
    <div style="flex:1"><b>${hidden} more section${hidden>1?'s':''} unlock next.</b>
    <span class="muted small">Finish <b>${esc(gate.title)}</b> — once your credentialing team approves it (or unlocks it for you), the rest of the checklist appears here.</span></div>
  </div></div>`;
}
function physProfile(p){
  return `<button class="backlink" data-tab="checklist">${ICON.back} Back to checklist</button>
  <div class="card" style="max-width:620px;margin-bottom:16px"><div class="card-b" style="display:flex;gap:16px;align-items:center">
    <div class="avatar" style="width:58px;height:58px;font-size:20px">${p.init}</div>
    <div><h2 style="font-size:20px">${esc(p.name)}</h2><p class="muted" style="margin:2px 0 0">${esc(p.specialty)} · ${esc(p.location)}</p></div>
  </div></div>
  <div class="card" style="max-width:620px"><div class="card-h"><h3>Account</h3><button class="btn subtle sm">Edit</button></div>
    <div class="card-b"><div class="kv">
      <div class="k">Full name</div><div>${esc(p.name)}</div>
      <div class="k">Specialty</div><div>${esc(p.specialty)}</div>
      <div class="k">NPI</div><div>${esc(p.npi)}</div>
      <div class="k">Email</div><div>${esc(p.email)}</div>
      <div class="k">Phone</div><div>${esc(p.phone)}</div>
      <div class="k">Location</div><div>${esc(p.location)}</div>
    </div></div></div>`;
}

/* ============================================================
   Team dashboard
   ============================================================ */
function viewTeam(){
  let body;
  if(!internalMode()&&state.teamView==="reports") body=teamReports();
  else if(state.teamView==="detail" && sel()) body=teamDetail(sel());
  else body=teamRoster();
  return `<div class="wrap">${body}</div>`;
}
function teamReports(){
  const ps=state.physicians;
  const deals={pending:0,completed:0,cancelled:0};
  let complete=0, expired=0, soon=0;
  ps.forEach(p=>{ const d=dealOf(p); deals[d.status]=(deals[d.status]||0)+1; if(isComplete(p))complete++; const e=expiryCounts(p); expired+=e.expired; soon+=e.soon; });
  const tile=(cls,n,l)=>`<div class="stat ${cls}"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  // Providers needing attention: expired/expiring docs or cancelled/pending-but-complete
  const attention=ps.map(p=>{ const e=expiryCounts(p); return {p,e}; }).filter(x=>x.e.expired||x.e.soon);
  const attRows=attention.map(({p,e})=>{
    const d=dealOf(p);
    return `<tr class="rowlink" data-open-p="${p.id}">
      <td><div class="who"><div class="avatar">${p.init}</div><div><div class="nm">${esc(p.name)}</div><div class="sp">${esc(p.email)}</div></div></div></td>
      <td><span class="badge ${DEAL_BADGE[d.status]}">${DEAL_LABEL[d.status]}</span></td>
      <td class="small">${e.expired?`<span style="color:var(--red);font-weight:600">${e.expired} expired</span>`:''}${e.expired&&e.soon?' · ':''}${e.soon?`<span style="color:var(--amber);font-weight:600">${e.soon} expiring</span>`:''}</td>
      <td><button class="btn subtle sm" data-open-p="${p.id}">Open ${ICON.arrow}</button></td>
    </tr>`;
  }).join("");
  return `
  <div style="margin-bottom:18px"><h1 style="font-size:24px">Reports</h1>
    <p class="muted" style="margin:4px 0 0">Pipeline, deal outcomes and document expirations across all providers.</p></div>
  <div class="sectitle" style="margin-bottom:10px">Pipeline &amp; deals</div>
  <div class="stats" style="margin-bottom:20px">
    ${tile('',ps.length,'Providers')}
    ${tile('p',deals.pending,'In pipeline')}
    ${tile('a',deals.completed,'Deals completed')}
    ${tile('r',deals.cancelled,'Deals cancelled')}
  </div>
  <div class="sectitle" style="margin-bottom:10px">Readiness &amp; expirations</div>
  <div class="stats" style="margin-bottom:20px">
    ${tile('a',complete,'Files complete')}
    ${tile('r',expired,'Expired documents')}
    ${tile('p',soon,'Expiring \u226430 days')}
  </div>
  <div class="card"><div class="card-h"><h3>Needs attention (expiring / expired)</h3><span class="muted small">${attention.length} provider${attention.length!==1?'s':''}</span></div>
    <div class="card-b" style="padding:6px 8px"><table class="roster">
      <thead><tr><th>Provider</th><th>Deal</th><th>Documents</th><th></th></tr></thead>
      <tbody>${attRows||`<tr><td colspan="4" style="padding:26px 16px;text-align:center" class="muted">No expiring or expired documents. \uD83C\uDF89</td></tr>`}</tbody></table></div></div>`;
}
function teamRoster(){
  const copy=audience();
  const ps=state.physicians;
  const complete=ps.filter(p=>completeness(p).pct===100).length;
  const inReview=ps.reduce((a,p)=>a+counts(p).pending,0);
  const needAtt=ps.reduce((a,p)=>a+counts(p).attention,0);
  const filters={
    all:{label:copy.all, match:()=>true},
    complete:{label:'Files complete', match:p=>completeness(p).pct===100},
    review:{label:'Items in review', match:p=>counts(p).pending>0},
    attention:{label:'Need attention', match:p=>counts(p).attention>0},
  };
  const activeKey = (state.rosterFilter && filters[state.rosterFilter]) ? state.rosterFilter : 'all';
  const shown = ps.filter(filters[activeKey].match);
  const rows=shown.map(p=>{
    const c=completeness(p),ct=counts(p);
    const flag=ct.attention?badge("attention"):(c.pct===100?badge("approved"):badge("pending"));
    const tn=notifCount(p,"team");
    const notes=ALL_KEYS.filter(i=>p.docs[i.key].notes.length).length;
    const deal=dealOf(p); const ex=expiryCounts(p);
    const expTxt = ex.expired?`<span style="color:var(--red);font-weight:600"> · ${ex.expired} expired</span>`:(ex.soon?`<span style="color:var(--amber);font-weight:600"> · ${ex.soon} expiring</span>`:"");
    const dealCell=internalMode()?"":`<td><span class="badge ${DEAL_BADGE[deal.status]}">${DEAL_LABEL[deal.status]}</span></td>`;
    return `<tr class="rowlink" data-open-p="${p.id}">
      <td><div class="who"><div class="avatar">${p.init}</div><div><div class="nm">${esc(p.name)}</div><div class="sp">${esc(p.specialty)}</div></div></div></td>
      <td><div class="mini-prog"><div class="prog"><i style="width:${c.pct}%"></i></div><span class="small muted">${c.done}/${c.total}</span></div></td>
      ${dealCell}
      <td class="small muted">${ct.attention?`<span style="color:var(--red);font-weight:600">${ct.attention} to fix</span> · `:""}${ct.pending} in review${expTxt}</td>
      <td class="small ${tn?'':'muted'}" style="${tn?'color:var(--red);font-weight:600':''}">${ICON.chat} ${notes} note${notes!==1?'s':''}${tn?` · ${tn} new`:''}</td>
      <td><button class="btn subtle sm" data-open-p="${p.id}">Open ${ICON.arrow}</button></td>
    </tr>`;
  }).join("");
  const emptyMsg = activeKey==='all' ? copy.empty : `No ${copy.plural} match this filter.`;
  const tbody = rows || `<tr><td colspan="6" style="padding:34px 16px;text-align:center" class="muted">${emptyMsg}</td></tr>`;
  const tile=(key,cls,num,label)=>`<button class="stat ${cls} ${activeKey===key?'active':''}" data-rfilter="${key}" aria-pressed="${activeKey===key}"><div class="n">${num}</div><div class="l">${label}</div></button>`;
  const filterBar = activeKey!=='all' ? `<div class="filter-bar"><span class="filter-chip">Filtered: ${filters[activeKey].label} <b>(${shown.length})</b></span><button class="btn ghost sm" data-rfilter="all">Clear filter ✕</button></div>` : "";
  const dealHead=internalMode()?"":"<th>Deal</th>";
  return `
  <div style="margin-bottom:18px"><h1 style="font-size:24px">${copy.title}</h1>
    <p class="muted" style="margin:4px 0 0">${copy.intro}</p></div>
  <div class="stats" style="margin-bottom:${activeKey!=='all'?'12px':'22px'}">
    ${tile('all','', ps.length,copy.active)}
    ${tile('complete','a',complete,'Files complete')}
    ${tile('review','p',inReview,'Items in review')}
    ${tile('attention','r',needAtt,'Need attention')}
  </div>
  ${filterBar}
  <div class="card"><div class="card-h"><h3>${copy.all}</h3><input placeholder="${copy.search}" style="border:1px solid var(--line);border-radius:8px;padding:7px 11px;font-size:13px;width:210px"></div>
    <div class="card-b" style="padding:6px 8px"><table class="roster">
      <thead><tr><th>${copy.person}</th><th>Completeness</th>${dealHead}<th>Detail</th><th>Notes</th><th></th></tr></thead>
      <tbody>${tbody}</tbody></table></div></div>`;
}
function teamDetail(p){
  const copy=audience();
  const c=completeness(p);
  const dfilters={
    missing:{label:'Not provided', match:d=>d.status==='missing'},
    pending:{label:'Pending approval', match:d=>d.status==='pending'},
    attention:{label:'Needs attention', match:d=>d.status==='attention'},
    notes:{label:'Note added', match:d=>d.notes&&d.notes.length>0},
  };
  const cnt={missing:0,pending:0,attention:0,notes:0};
  ALL_KEYS.forEach(i=>{const d=p.docs[i.key]; if(d.status==='missing')cnt.missing++; if(d.status==='pending')cnt.pending++; if(d.status==='attention')cnt.attention++; if(d.notes&&d.notes.length)cnt.notes++;});
  const activeKey=(state.detailFilter&&dfilters[state.detailFilter])?state.detailFilter:null;
  const fn = activeKey?dfilters[activeKey].match:null;
  const btn=(key,label)=>`<button class="dfbtn ${activeKey===key?'on':''}" data-dfilter="${key}" aria-pressed="${activeKey===key}">${label} <b>${cnt[key]}</b></button>`;
  const filterRow=`<div class="detail-filters">
    ${btn('missing','Not provided')}${btn('pending','Pending approval')}${btn('attention','Needs attention')}${btn('notes','Note added')}
    ${activeKey?`<button class="dfbtn clear" data-dfilter="all">Clear filter \u2715</button>`:''}
  </div>`;
  const sections=CHECKLIST.map(s=>sectionCard(p,s,true,fn)).join("");
  const empty = fn && !sections.trim() ? `<div class="card"><div class="card-b muted" style="text-align:center;padding:30px"><b>Nothing matches this filter.</b><div class="small muted" style="margin-top:4px">No documents are “${dfilters[activeKey].label}” for ${esc(p.name)}.</div></div></div>` : '';
  const deal=dealOf(p); const complete=isComplete(p); const today=new Date().toISOString().slice(0,10);
  const statusChips=`<span class="badge ${DEAL_BADGE[deal.status]}">${DEAL_LABEL[deal.status]}${deal.status==='completed'&&deal.activeDate?` · since ${fmtDay(new Date(deal.activeDate))}`:''}</span>${complete?'<span class="badge b-approved">All documents complete</span>':''}`;
  const dealActions = deal.status==='completed'
    ? `<button class="btn subtle sm" data-deal="pending">Reopen pipeline</button><button class="btn ghost sm" data-deal="cancelled">Cancel deal</button>`
    : (deal.status==='cancelled'
      ? `<button class="btn subtle sm" data-deal="pending">Restore to pipeline</button>`
      : `<button class="btn sm" data-dealpick>${ICON.shield} Mark Active</button><button class="btn ghost sm" data-deal="cancelled">Cancel deal</button>`);
  const dealBar=`<div class="deal-bar${complete&&deal.status==='pending'?' ready':''}">
    <div class="deal-status">${statusChips}<span class="muted small">${deal.status==='completed'?'Provider/patients are seen from the active date forward.':(complete?'All documents are complete — ready to mark the deal Active.':'Deal is in the pipeline while documents are collected.')}</span></div>
    <div class="deal-actions">${dealActions}</div>
  </div>`;
  return `<button class="backlink" data-goroster>${ICON.back} ${copy.all}</button>
  <div class="card" style="margin-bottom:14px"><div class="card-b" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
    <div class="avatar" style="width:56px;height:56px;font-size:20px">${p.init}</div>
    <div style="flex:1;min-width:230px"><h2 style="font-size:20px">${esc(p.name)}</h2><p class="muted small" style="margin:2px 0 0">${internalMode()?`${esc(p.specialty)} · ${esc(p.email)}`:`${esc(p.specialty)} · NPI ${esc(p.npi)} · ${esc(p.email)}`}</p></div>
    <div style="min-width:190px"><div class="small muted" style="display:flex;justify-content:space-between;margin-bottom:5px"><span>${c.done}/${c.total} approved</span><b>${c.pct}%</b></div><div class="prog"><i style="width:${c.pct}%"></i></div></div>
    <button class="btn subtle sm packet-download" data-gather="${p.id}">${ICON.file} Download packet + files</button>
  </div></div>
  ${internalMode()?"":dealBar}
  ${filterRow}
  ${sections||empty}`;
}

/* ============================================================
   Section card + item rows (shared)
   ============================================================ */
function sectionCard(p,sec,teamMode,filterFn){
  const items = filterFn ? sec.items.filter(def=>filterFn(p.docs[def.key],def)) : sec.items;
  if(filterFn && !items.length) return "";
  const sp=secProgress(p,sec);
  const collapsed=isSecCollapsed(p,sec,teamMode,filterFn);
  const rows=items.map(def=>itemRow(p,def,teamMode)).join("");
  const gateTag = sec.gate ? `<span class="gate-tag" title="Later sections stay hidden until this one is complete or unlocked">${ICON.lock} Gate</span>` : "";
  return `<div class="card sec ${collapsed?'collapsed':''}">
    <div class="sec-h" data-sec="${sec.n}">
      <div class="num">${sec.n}</div><h3>${sec.title}</h3>${gateTag}
      <div class="mini"><div class="prog"><i style="width:${sp.pct}%"></i></div><span class="small muted">${sp.done}/${sp.total}</span></div>
      <span class="chev">${ICON.chev}</span>
    </div>
    ${teamMode&&!filterFn?gateControls(p,sec):""}
    <div class="sec-b">${rows}</div>
  </div>`;
}
// Team-only controls under a section header: toggle the gate for everyone and
// (when the gate is closed) unlock the following sections for this one provider.
function gateControls(p,sec){
  const gated=!!sec.gate;
  const complete=sectionComplete(p,sec);
  const acked=sectionAcked(p,sec);
  const sw=`<button class="gate-sw ${gated?'on':''}" data-gate="${sec.id}" role="switch" aria-checked="${gated}" title="Hide later sections until this one is complete or acknowledged"><span class="gate-knob"></span></button>`;
  let status;
  if(!gated){
    status=`<span class="gate-st muted">Later sections always visible</span>`;
  } else if(complete){
    status=`<span class="gate-st ok">${ICON.shield} Complete — later sections unlocked</span>`;
  } else if(acked){
    const a=p.sectionAcks[sec.id]||{};
    status=`<span class="gate-st ok">${ICON.shield} Unlocked by ${esc(a.name||'team')} · <button class="linkbtn" data-ack="${sec.id}|off">Re-lock</button></span>`;
  } else {
    status=`<span class="gate-st">Later sections hidden from ${esc(firstNameOf(p.name))} · <button class="btn subtle sm" data-ack="${sec.id}|on">Unlock sections</button></span>`;
  }
  return `<div class="sec-gate"><label class="gate-lbl">${sw} <span>Hide later sections until complete or acknowledged</span></label>${status}</div>`;
}
function rowDetail(def,d){
  if(def.type==="access") return d.status==="approved"?(d.access==="yes"?"Access confirmed":"No access reported"):(def.hint||"Do you have access?");
  if(def.type==="info"){
    const tf=(def.fields||[]).filter(fl=>fl.type!=="upload");
    if(tf.length){
      const fv=d.fieldValues||{}; const filled=tf.filter(fl=>String(fv[fl.key]||"").trim()).length;
      if(d.status==="attention"&&d.note) return `<span style="color:var(--red)">${esc(d.note)}</span>`;
      if(!filled) return def.hint||`${tf.length} field${tf.length!==1?'s':''} to fill in`;
      return `${filled} of ${tf.length} fields provided`;
    }
    if(d.status==="attention"&&d.note) return `<span style="color:var(--red)">${esc(d.note)}</span>`;
    if(d.status==="missing") return def.hint||"Not provided yet";
    return d.value?esc(d.value):`Provided · updated ${d.updated}`;
  }
  if(d.status==="missing") return def.hint||"Not provided yet";
  const n=(d.files||[]).length;
  if(n>1) return `${n} files · latest ${d.updated}`;
  if(d.status==="attention"&&d.note) return `<span style="color:var(--red)">${esc(d.note)}</span>`;
  return `${esc(d.file||"document.pdf")} · updated ${d.updated}`;
}
function itemRow(p,def,teamMode){
  const d=p.docs[def.key];
  const viewer=teamMode?"team":"physician";
  const dot=d.notif[viewer]?`<span class="ndot"></span>`:"";
  const nc=d.notes.length;
  const chip=nc
    ? `<span class="notes-chip ${d.notif[viewer]?'hot':''}">${ICON.chat} ${nc}</span>`
    : `<span class="notes-chip">${ICON.chat} Note</span>`;
  let action;
  if(def.type==="access"){
    action=`<div class="yn">
      <button class="yn-b ${d.access==='yes'?'on':''}" data-access="${def.key}|yes">Yes</button>
      <button class="yn-b ${d.access==='no'?'on no':''}" data-access="${def.key}|no">No</button></div>`;
  } else {
    const label=d.status==="missing"?(def.type==="info"?"Add":"Upload"):(def.type==="info"?"Edit":"Add file");
    action=`<button class="btn ${d.status==='missing'||d.status==='attention'?'':'subtle'} sm" data-provide="${def.key}">${def.type==='info'?'':ICON.up+' '}${label}</button>`;
  }
  const teamApprove=teamMode&&def.type!=="access"&&d.status!=="missing"&&d.status!=="approved"
    ?`<button class="btn sm" data-review="${def.key}|approve">Approve${(d.files||[]).length>1?' all':''}</button>`:"";
  const viewBtn=d.fileId?`<button class="btn subtle sm" data-view="${def.key}" title="Open document">${ICON.file} View</button>`:"";
  const exp=expiryBadge(def.key,d);
  return `<div class="item" data-open="${def.key}">
    <div class="fic">${dot}${ICON.file}</div>
    <div class="dinfo"><div class="dt">${def.name}</div><div class="ds">${rowDetail(def,d)}${exp?` · ${exp}`:''}</div></div>
    <div class="dact">${chip}${itemBadge(def,d)}${viewBtn}${teamApprove}${action}</div>
  </div>`;
}

/* ============================================================
   Document drawer (preview + notes)
   ============================================================ */
let _drawerScrollY=0;
function lockBodyScroll(){_drawerScrollY=window.scrollY||window.pageYOffset||0;document.body.style.top=(-_drawerScrollY)+"px";document.body.classList.add("drawer-open");}
function unlockBodyScroll(){document.body.classList.remove("drawer-open");document.body.style.top="";window.scrollTo(0,_drawerScrollY);}
function openDrawer(key){
  const p=activeP();
  p.docs[key].notif[state.role]=false;
  state.drawer=key;
  state.drawerTab="preview";
  state.fileIdx=0;
  state.fileZoom=1;
  lockBodyScroll();
  renderDrawer();
}
function closeDrawer(){state.drawer=null;unlockBodyScroll();$("#modalRoot").innerHTML="";render();}
function previewHTML(p,def,d){
  if(def.type==="access"){
    const ans=d.status==="approved";
    return `<div class="pv-access ${ans?(d.access==='yes'?'yes':'no'):''}">
      <div class="pv-a-ic">${ans?(d.access==='yes'?'✓':'—'):'?'}</div>
      <div class="pv-a-t">${ans?(d.access==='yes'?'Access confirmed':'No access reported'):'Not answered yet'}</div>
      <div class="muted small" style="margin-top:4px">${esc(def.name)}</div></div>`;
  }
  const fields=def.fields||[];
  const typed=fields.filter(fl=>fl.type!=="upload");
  const hasUpload=def.type==="doc"||fields.some(fl=>fl.type==="upload");
  // Legacy info item (no fields, no upload): single free-text value.
  if(def.type==="info" && !typed.length && !hasUpload){
    if(d.status==="missing"){
      return `<div class="pv-empty"><div class="di">${ICON.up}</div><b>Nothing provided yet</b>
        <div class="small muted" style="margin:5px 0 14px">${esc(def.hint||'')}</div>
        <button class="btn sm" data-provide="${def.key}">Add information</button></div>`;
    }
    return `<div class="pv-info"><div class="pv-info-h">${esc(def.name)}</div>
      <div class="pv-info-v">${esc(d.value||'Information provided')}</div>
      <div class="small muted" style="margin-top:10px">Updated ${d.updated||'recently'}</div></div>`;
  }
  let html="";
  if(typed.length) html+=fieldsFormHTML(p,def,d,typed);
  if(hasUpload) html+=documentViewerHTML(p,def,d);
  return html;
}
// The document upload area: single large viewer + carousel + zoom over d.files.
function documentViewerHTML(p,def,d){
  const list=d.files||[];
  const canAdd=state.role==="physician"||state.role==="team";
  if(!list.length){
    return `<div class="pv-empty"><div class="di">${ICON.up}</div><b>Nothing uploaded yet</b>
      <div class="small muted" style="margin:5px 0 14px">${esc(def.hint||'')} You can add more than one file.</div>
      ${canAdd?`<button class="btn sm" data-provide="${def.key}">${ICON.up} Upload document</button>`:''}</div>`;
  }
  let idx=state.fileIdx||0; if(idx>=list.length) idx=list.length-1; if(idx<0) idx=0; state.fileIdx=idx;
  const f=list[idx];
  const multi=list.length>1;
  const nav=multi?`
    <button class="carousel-nav prev" data-fileprev aria-label="Previous file">${CAL_PREV}</button>
    <button class="carousel-nav next" data-filenext aria-label="Next file">${CAL_NEXT}</button>`:"";
  const dots=multi?`<div class="fv-dots"><span class="fv-count">File ${idx+1} of ${list.length}</span><div class="fv-dot-row">${list.map((x,i)=>`<button class="fv-dot ${i===idx?'on':''}" data-filego="${i}" aria-label="File ${i+1}"></button>`).join("")}</div></div>`:"";
  const zoomable=f.mime && (f.mime.indexOf("image/")===0 || f.mime==="application/pdf");
  const z=state.fileZoom||1;
  const zoomCtl=zoomable?`<div class="fv-zoom">
    <button class="fv-zbtn" data-zoom="out" aria-label="Zoom out">${ICON.zout}</button>
    <button class="fv-zbtn fv-zlabel" data-zoom="reset" aria-label="Reset zoom">${Math.round(z*100)}%</button>
    <button class="fv-zbtn" data-zoom="in" aria-label="Zoom in">${ICON.zin}</button>
  </div>`:"";
  return `<div class="fileviewer">
    <div class="fv-media"><div class="fv-scale" style="transform:scale(${z})">${fileMediaHTML(def,f)}</div>${nav}${zoomCtl}</div>
    ${dots}
    <div class="fv-controls">${fileControlsHTML(p,def,f)}</div>
  </div>`;
}
// Large single-file preview that fills the viewer.
function fileMediaHTML(def,f){
  if(f.mime&&f.mime.indexOf("image/")===0)
    return `<img src="${esc(f.url)}" alt="${esc(def.name)}">`;
  if(f.mime==="application/pdf")
    return `<iframe src="${esc(f.url)}" title="${esc(def.name)}"></iframe>`;
  if(f.office)
    return `<div class="fv-doc"><div class="di">${ICON.doc2}</div><b>${esc(f.name)}</b>
      <div class="small muted" style="margin:5px 0 12px">Microsoft Office document.</div>
      <button class="btn sm" data-viewfid="${f.id}">${ICON.file} Open in Microsoft viewer</button></div>`;
  return `<div class="fv-doc"><div class="di">${ICON.file}</div><b>${esc(f.name)}</b>
    <div class="small muted" style="margin:5px 0 12px">Uploaded document.</div>
    <button class="btn sm" data-viewfid="${f.id}">${ICON.file} Open</button></div>`;
}
// Controls for the file currently shown in the viewer.
function fileControlsHTML(p,def,f){
  const sc=f.status||"pending";
  const isTeam=state.role==="team";
  const exp=(EXPIRY_OF[def.key]==="expires")?expiryBadge(def.key,f):"";
  const teamRow=isTeam?`
    ${sc!=="approved"?`<button class="btn sm" data-filereview="${f.id}|approved">Approve</button>`:''}
    <button class="btn ghost sm" data-filereview="${f.id}|attention">Request fix</button>`:"";
  // Replace this file, add more files, or delete — kept together.
  const editRow=`
    <button class="btn subtle sm" data-replacefile="${def.key}|${f.id}">${ICON.up} Replace</button>
    <button class="btn subtle sm" data-provide="${def.key}">${ICON.up} Add more</button>
    <button class="btn ghost sm" data-deletefile="${def.key}|${f.id}">Delete</button>`;
  const expControl=(isTeam && EXPIRY_OF[def.key]==="expires")
    ? `<div class="exp-control" style="margin-top:2px"><label>Expiry / renew-by date</label><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn subtle sm" data-pickexp="${f.id}">${ICON.cal} ${f.expiresAt?fmtDay(new Date(f.expiresAt)):'Set date'}</button>${exp}</div></div>`
    : "";
  const fnote=(sc==="attention"&&f.note)?`<div class="small" style="color:var(--red);margin-top:2px">${esc(f.note)}</div>`:"";
  return `<div class="pv-file-bar">
      <span class="stamp ${sc}">${STATUS[sc].label.toUpperCase()}</span>
      <span class="small muted" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}${f.updated?` · ${f.updated}`:''}</span>
      <button class="btn subtle sm" data-viewfid="${f.id}">Open</button>
      <a class="btn ghost sm" href="${esc(f.url)}?dl=1" download="${esc(f.name)}">Download</a>
    </div>
    ${fnote}
    <div class="pv-file-bar">${teamRow}${editRow}</div>
    ${expControl}`;
}
/* ---------- custom input fields (non-document info) ---------- */
// One input for a field definition, prefilled with the current value.
function fieldInputHTML(fl,v,canEdit){
  const id="fld-"+fl.key;
  const dis=canEdit?"":"disabled";
  if(fl.type==="textarea") return `<textarea id="${id}" class="ff-in" rows="2" ${dis}>${esc(v)}</textarea>`;
  if(fl.type==="select"){
    const opts=(fl.options||[]).map(o=>`<option ${o===v?'selected':''}>${esc(o)}</option>`).join("");
    return `<select id="${id}" class="ff-in" ${dis}><option value="">—</option>${opts}</select>`;
  }
  if(fl.type==="date"){
    return `<input type="hidden" id="${id}" value="${esc(v)}"><button type="button" class="btn subtle sm ff-datebtn" data-fielddate="${fl.key}" ${dis}>${ICON.cal} ${v?esc(v):'Set date'}</button>`;
  }
  const t=fl.type==="number"?"number":fl.type==="email"?"email":fl.type==="phone"?"tel":"text";
  return `<input id="${id}" class="ff-in" type="${t}" value="${esc(v)}" ${dis}>`;
}
function fieldsFormHTML(p,def,d,fields){
  const list=fields||(def.fields||[]).filter(fl=>fl.type!=="upload");
  const vals=d.fieldValues||{};
  const meta=d.fieldMeta||{};
  const canEdit=state.role==="physician"||state.role==="team";
  const rows=list.map(fl=>{
    const m=meta[fl.key];
    const byLine=m?`<div class="ff-by ${m.by==='team'?'by-team':'by-phys'}">${m.by==='team'?'Filled in by staff':'Provided by physician'} · ${esc(m.name||'')}${m.at?` · ${esc(fmtWhen(m.at))}`:''}</div>`:"";
    return `<div class="ff-view"><label class="ff-view-l">${esc(fl.label)}</label>${fieldInputHTML(fl,vals[fl.key]!=null?vals[fl.key]:"",canEdit)}${byLine}</div>`;
  }).join("");
  const intro=state.role==="team"
    ? 'You can complete or correct these fields on behalf of the provider — your name is recorded on any field you change.'
    : (canEdit?'Fill in the information below and save.':'Information provided.');
  return `<div class="fieldform">
    <div class="small muted" style="margin-bottom:4px">${intro}</div>
    ${rows}
    ${canEdit?`<button class="btn sm" data-savefields="${def.key}" style="align-self:flex-start;margin-top:6px">Save information</button>`:''}
  </div>`;
}
// Physician or staff saves the typed field values; edits are attributed per field
// and persisted to the backend so everyone who references the record sees them.
function saveFields(key){
  const p=activeP(); const def=ALL_KEYS.find(i=>i.key===key); const d=p.docs[key];
  const fv={};
  (def.fields||[]).forEach(fl=>{
    if(fl.type==="upload") return;
    const el=document.getElementById("fld-"+fl.key); fv[fl.key]=el?el.value:"";
  });
  // Optimistic local update (server returns authoritative values + authorship).
  d.fieldValues=fv;
  d.status="pending"; d.note=""; d.updated="Jul 16";
  const headers={"Content-Type":"application/json"};
  if(p&&p.id) headers["X-Owner"]=p.id; // team saves on behalf of the provider
  fetch("/api/fields/"+encodeURIComponent(key),{method:"PUT",credentials:"same-origin",headers,body:JSON.stringify({values:fv})})
    .then(r=>r.ok?r.json():null)
    .then(res=>{ if(res&&res.fields){ d.fieldValues=res.fields.values||fv; d.fieldMeta=res.fields.meta||d.fieldMeta; renderDrawer(); } })
    .catch(()=>{});
  toast("Information saved",`${def.name} has been saved.${state.role==="team"?" Recorded on behalf of "+esc(p.name)+".":" Your credentialing team can see it."}`,{icon:ICON.doc2});
  renderDrawer();
}
function renderDrawer(){
  const root=$("#modalRoot");
  saveNav();
  if(!state.drawer){root.innerHTML="";return;}
  const p=activeP();
  const def=ALL_KEYS.find(i=>i.key===state.drawer);
  const d=p.docs[def.key];
  const viewer=state.role;
  const thread=d.notes.length?d.notes.map(n=>{
    const mine=n.from===viewer;
    const via=n.viaEmail?`<span class="via">${ICON.mail} also emailed</span>`:"";
    return `<div class="nmsg ${mine?'me':'them'}"><div class="bubble">${esc(n.text)}</div><div class="meta">${mine?'You':esc(n.author)} · ${n.time} ${via}</div></div>`;
  }).join(""):`<div class="notes-empty">No notes on this document yet.<br>Start the conversation below.</div>`;
  const other=viewer==="physician"?"the credentialing team":esc(p.name);
  // Team review of INFO items stays at the document level (they carry no files);
  // uploaded documents are reviewed per-file inside the preview cards.
  const teamBtns=(state.role==="team" && def.type==="info" && d.status!=="missing")?`
    ${d.status!=="approved"?`<button class="btn sm" data-dreview="${def.key}|approve">Approve</button>`:''}
    <button class="btn ghost sm" data-dreview="${def.key}|fix">Request fix</button>`:"";
  root.innerHTML=`<div class="modal-bg" data-bg><div class="modal drawer">
    <div class="m-h">
      <div style="flex:1;min-width:0"><div class="small muted">Section ${SEC_OF[def.key]} · ${esc(p.name)}</div><h3 style="font-size:16px">${esc(def.name)}</h3></div>
      ${itemBadge(def,d)}<span class="team-actions team-actions--head">${teamBtns}</span><button class="xbtn" data-dclose>✕</button>
    </div>
    <div class="drawer-tabs" role="tablist">
      <button class="drawer-tab ${(state.drawerTab||'preview')==='preview'?'active':''}" data-drawertab="preview">Preview</button>
      <button class="drawer-tab ${state.drawerTab==='notes'?'active':''}" data-drawertab="notes">Notes${d.notes.length?` (${d.notes.length})`:''}</button>
    </div>
    <div class="drawer-b" data-dtab="${state.drawerTab||'preview'}">
      <div class="pv-col"><div class="sectitle">Document preview</div>${previewHTML(p,def,d)}
        <div class="small muted">${def.type==='info'?'Information the physician provided.':def.type==='access'?'Physician web-access response.':'Each uploaded file is reviewed individually. Files open in a secure viewer.'}</div>
        ${teamBtns.trim()?`<div class="team-actions team-actions--foot">${teamBtns}</div>`:""}
      </div>
      <div class="notes-col">
        <div class="sectitle">Notes on this document</div>
        <div class="notes-stream">${thread}</div>
        <div class="notes-note">${state.otherOnline?`${cap(other)} is online — notes deliver in-app`:`${cap(other)} is offline — a note also emails them`}</div>
        <div class="notes-composer"><textarea id="noteInput" placeholder="Add a note about ${esc(def.name)}…"></textarea><button class="btn sm" data-notesend>${ICON.send}</button></div>
      </div>
    </div>
  </div></div>`;
  bindDrawer();
  const st=root.querySelector(".notes-stream"); if(st) st.scrollTop=st.scrollHeight;
  const ni=$("#noteInput"); if(ni) ni.focus();
}
function postNote(key){
  const box=$("#noteInput"); if(!box) return;
  const text=box.value.trim(); if(!text) return;
  const p=activeP(); const def=ALL_KEYS.find(i=>i.key===key); const d=p.docs[key];
  const poster=state.role;
  const author=poster=="physician"?p.name:teamName();
  const willEmail=!state.otherOnline;
  d.notes.push({from:poster,author,text,time:nowStr(),viaEmail:willEmail});
  d.notif[poster==="physician"?"team":"physician"]=true;
  d.notif[poster]=false;
  if(willEmail){
    if(poster==="physician") toast("Note emailed to team",`Your note on <b>${esc(def.name)}</b> was emailed to the credentialing team at <b>credentialing@uploaddoc.io</b> (no one is logged in).`);
    else toast("Note emailed to physician",`Your note on <b>${esc(def.name)}</b> was emailed to ${esc(p.name)} at <b>${esc(p.email)}</b> (they're offline).`);
  } else {
    toast("Note delivered in-app",`Your note on <b>${esc(def.name)}</b> was delivered instantly — the recipient is online, no email sent.`,{icon:ICON.chat});
  }
  renderDrawer();
}
function drawerReview(spec){
  const [key,action]=spec.split("|");
  const p=sel(); const def=ALL_KEYS.find(i=>i.key===key); const d=p.docs[key];
  if(action==="approve"){
    const expEl=document.getElementById('drawerExpiry');
    if(expEl&&expEl.value) d.expiresAt=expEl.value;
    d.status="approved"; d.note="";
    persistReview(d,"approved","",d.expiresAt||undefined);
    toast("Document approved",`${def.name} for ${esc(p.name)} marked approved.`,{icon:ICON.shield});
    renderDrawer();
  } else {
    openModal2(`
      <div class="m-h"><div style="width:34px;height:34px;border-radius:9px;background:var(--amber-100);color:var(--amber);display:flex;align-items:center;justify-content:center">${ICON.file}</div>
        <div><h3 style="font-size:16px">Request a fix</h3><p class="muted small" style="margin-top:2px">${def.name} · ${esc(p.name)}</p></div></div>
      <div class="m-b"><div class="field"><label>What needs to change?</label>
        <textarea id="fixNote" rows="3">Please re-upload a clear, current copy of this document.</textarea></div>
        <p class="small muted">Posted as a note on this document and sent to the physician${state.otherOnline?"":" (also emailed, since they're offline)"}.</p></div>
      <div class="m-f"><button class="btn subtle" data-close2>Cancel</button><button class="btn" data-confirmfix="${key}">Send request</button></div>`);
  }
}
function confirmFix(key){
  const p=sel(); const def=ALL_KEYS.find(i=>i.key===key); const d=p.docs[key];
  const note=($("#fixNote")&&$("#fixNote").value.trim())||"Please re-upload a clear, current copy.";
  d.status="attention"; d.note=note;
  persistReview(d,"attention",note);
  d.notes.push({from:"team",author:teamName(),text:`Action needed on ${def.name}: ${note}`,time:nowStr(),viaEmail:!state.otherOnline});
  d.notif.physician=true;
  closeModal2();
  if(!state.otherOnline) toast("Fix requested + emailed",`${esc(p.name)} is offline — the request was emailed to <b>${esc(p.email)}</b>.`);
  else toast("Fix requested",`${esc(p.name)} was notified in-app.`,{icon:ICON.chat});
  if(state.drawer) renderDrawer(); else render();
}

/* ============================================================
   Provide / upload
   ============================================================ */
let pendingUpload=null;
let replaceTargetId=null;
const UPLOAD_ACCEPT=".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx";
function openProvide(key, replaceId){
  const def=ALL_KEYS.find(i=>i.key===key);
  const isInfo=def.type==="info";
  pendingUpload=null;
  replaceTargetId=replaceId||null;
  const heading=isInfo?`Provide — ${esc(def.name)}`:(replaceId?`Replace file — ${esc(def.name)}`:`Upload — ${esc(def.name)}`);
  const confirmLabel=isInfo?'Save':(replaceId?'Replace file':'Upload document');
  openModal2(`
    <div class="m-h"><div style="width:34px;height:34px;border-radius:9px;background:var(--blue-100);color:var(--blue-700);display:flex;align-items:center;justify-content:center">${isInfo?ICON.doc2:ICON.up}</div>
      <div><h3 style="font-size:16px">${heading}</h3><p class="muted small" style="margin-top:2px">${esc(def.hint||'')}</p></div></div>
    <div class="m-b">
      ${isInfo
        ? `<div class="field"><label>Information</label><textarea id="infoVal" rows="3" placeholder="Enter ${esc(def.name)}…"></textarea></div>`
        : `<div class="drop" id="dropZone"><div class="di">${ICON.file}</div><b>Drag &amp; drop your file</b><div class="small" style="margin-top:4px">or click to browse · PDF, image, Word, Excel or PowerPoint up to 25&nbsp;MB</div>
            <input type="file" id="fileInput" accept="${UPLOAD_ACCEPT}" style="display:none">
            <div id="fileChosen" class="small" style="margin-top:10px;font-weight:600;color:var(--blue-700)"></div></div>
           <p class="small muted" style="margin-top:12px">${replaceId?'The current file is replaced once the new one uploads.':'You can add more than one file to this document.'}</p>`}
    </div>
    <div class="m-f"><button class="btn subtle" data-close2>Cancel</button><button class="btn" data-confirmprovide="${key}">${confirmLabel}</button></div>`);
}
async function confirmProvide(key){
  const p=activeP(); const def=ALL_KEYS.find(i=>i.key===key); const d=p.docs[key];
  if(def.type==="info"){
    const v=$("#infoVal")&&$("#infoVal").value.trim(); d.value=v||"Provided";
    d.status="pending"; d.note=""; d.updated="Jul 16";
    closeModal2();
    toast("Information saved",`${def.name} is now <b>pending review</b>. Your credentialing team has been notified.`,{icon:ICON.doc2});
    if(state.drawer) renderDrawer(); else render();
    return;
  }
  const f=pendingUpload;
  if(!f){ toast("Choose a file","Please select a file to upload first."); return; }
  const btn=$("#modalRoot2 [data-confirmprovide]"); const label=btn?btn.textContent:"";
  if(btn){ btn.disabled=true; btn.textContent="Uploading…"; }
  try{
    const headers={"X-Filename":f.name,"X-Dockey":key,"Content-Type":f.type||"application/octet-stream"};
    if(p&&p.id) headers["X-Owner"]=p.id; // team uploads on behalf of the provider
    const res=await fetch("/api/files",{method:"POST",headers,body:f});
    const data=await res.json().catch(()=>({}));
    if(!res.ok){ throw new Error(data.message||"Upload failed."); }
    // If replacing, delete the old file after the new one is stored.
    const wasReplace=!!replaceTargetId;
    if(replaceTargetId){
      try{ await fetch("/api/files/"+replaceTargetId,{method:"DELETE",credentials:"same-origin"}); }catch(e){}
      d.files=(d.files||[]).filter(x=>x.id!==replaceTargetId);
    }
    d.files=[fileEntry(data.file)].concat(d.files||[]);
    recomputeDoc(d);
    replaceTargetId=null; pendingUpload=null;
    state.fileIdx=0;
    closeModal2();
    toast(wasReplace?"File replaced":"Document uploaded",`${def.name} is now <b>pending review</b>. Your credentialing team has been notified.`,{icon:ICON.up});
    if(state.drawer) renderDrawer(); else render();
  }catch(e){
    if(btn){ btn.disabled=false; btn.textContent=label||"Upload document"; }
    toast("Upload failed",esc(e.message||"Something went wrong."));
  }
}
// Refresh a document's aggregate status + primary-file mirror fields after its
// files[] array changes (add / replace / delete / review).
function recomputeDoc(d){
  const list=d.files||[];
  d.status=aggStatus(list);
  if(list.length){
    const pr=list[0];
    d.file=pr.name; d.fileId=pr.id; d.fileUrl=pr.url; d.mime=pr.mime; d.inline=pr.inline;
    d.office=pr.office; d.updated=pr.updated; d.updatedIso=pr.updatedIso; d.expiresAt=pr.expiresAt; d.note=pr.note;
  } else {
    d.file=""; d.fileId=""; d.fileUrl=""; d.mime=""; d.office=false; d.updated=""; d.expiresAt=""; d.note="";
  }
}
// Locate a file entry (and its owning doc) by file id within a provider's docs.
function findFile(p,fileId){
  for(const k in p.docs){ const f=(p.docs[k].files||[]).find(x=>x.id===fileId); if(f) return {f,d:p.docs[k],key:k}; }
  return null;
}
async function deleteFile(key,fileId){
  const p=activeP(); const d=p.docs[key]; if(!d) return;
  if(!window.confirm("Delete this file? This can't be undone.")) return;
  try{
    const res=await fetch("/api/files/"+fileId,{method:"DELETE",credentials:"same-origin"});
    if(!res.ok){ const j=await res.json().catch(()=>({})); throw new Error(j.message||"Delete failed."); }
    d.files=(d.files||[]).filter(x=>x.id!==fileId);
    recomputeDoc(d);
    toast("File removed","The file was deleted from this document.",{icon:ICON.file});
    if(state.drawer) renderDrawer(); else render();
  }catch(e){ toast("Delete failed",esc(e.message||"Something went wrong.")); }
}
// Team: approve / request a fix on a single file.
function reviewFile(fileId,status){
  const p=sel(); if(!p) return;
  const hit=findFile(p,fileId); if(!hit) return;
  let note="";
  if(status==="attention"){ const r=window.prompt("What needs to change with this file?","Please re-upload a clear, current copy."); if(r===null) return; note=r; }
  hit.f.status=status; hit.f.note=status==="attention"?note:"";
  fetch("/api/files/"+fileId+"/review",{method:"PATCH",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({status,note:hit.f.note})}).catch(()=>{});
  recomputeDoc(hit.d);
  const nm=(ALL_KEYS.find(i=>i.key===hit.key)||{}).name||"Document";
  if(status==="approved") toast("File approved",`A file for ${nm} was marked approved.`,{icon:ICON.shield});
  else toast("Fix requested",`Asked ${esc(p.name)} for a new copy of ${nm}.`,{icon:ICON.chat});
  renderDrawer();
}
// Team: choose the expiry / renew-by date on a single file via the stylized calendar.
function pickFileExpiry(fileId){
  const p=sel(); if(!p) return;
  const hit=findFile(p,fileId); if(!hit) return;
  const nm=(ALL_KEYS.find(i=>i.key===hit.key)||{}).name||"Document";
  openCalendar({
    title:"Expiry / renew-by date", subtitle:nm,
    selectedLabel:"Expiry date",
    value:hit.f.expiresAt?String(hit.f.expiresAt).slice(0,10):"",
    confirmLabel:"Save date", headIcon:ICON.cal, allowClear:true,
    onConfirm:(iso)=>{
      hit.f.expiresAt=iso||"";
      fetch("/api/files/"+fileId+"/review",{method:"PATCH",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:hit.f.status,note:hit.f.note||"",expiresAt:hit.f.expiresAt||null})}).catch(()=>{});
      recomputeDoc(hit.d);
      toast("Expiry saved",hit.f.expiresAt?fmtDay(new Date(hit.f.expiresAt)):"Date cleared.",{icon:ICON.shield});
      renderDrawer();
    }
  });
}
async function officeViewerUrl(fileId){
  const res=await fetch("/api/files/"+encodeURIComponent(fileId)+"/office-url",{credentials:"same-origin"});
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.message||"Could not prepare the Microsoft viewer.");
  return "https://view.officeapps.live.com/op/view.aspx?src="+encodeURIComponent(location.origin+data.url);
}
function openOfficeFile(fileId){
  const tab=window.open("about:blank","_blank");
  if(tab) tab.opener=null;
  officeViewerUrl(fileId).then(url=>{
    if(tab) tab.location.replace(url);
    else window.open(url,"_blank","noopener");
  }).catch(e=>{
    if(tab) tab.close();
    toast("Microsoft viewer unavailable",esc(e.message||"Please download the file instead."));
  });
}
// Open a single file by id (Office docs via the Microsoft viewer, others directly).
function openFileById(fileId){
  const p=activeP(); const hit=findFile(p,fileId); if(!hit) return; const f=hit.f;
  if(f.office) openOfficeFile(f.id);
  else window.open(f.url,"_blank","noopener");
}
// Open an uploaded file: Office docs go to the free Microsoft Office Online
// viewer (new tab); PDFs/images/text open directly in a new browser tab.
function openFile(d){
  if(!d||!d.fileId) return;
  if(d.office) openOfficeFile(d.fileId);
  else {
    window.open(d.fileUrl,"_blank","noopener");
  }
}
function setAccess(spec){
  const [key,val]=spec.split("|");
  const p=activeP(); const d=p.docs[key];
  d.status="approved"; d.access=val;
  toast("Saved",`Web-access response recorded.`,{icon:ICON.shield});
  if(state.drawer) renderDrawer(); else render();
}
async function gather(id){
  const p=state.physicians.find(x=>x.id===id); if(!p) return;
  const n=ALL_KEYS.filter(i=>p.docs[i.key].status!=="missing"&&p.docs[i.key].type!=="access").length;
  try{
    const res=await fetch("/api/providers/"+encodeURIComponent(id)+"/packet",{credentials:"same-origin"});
    if(!res.ok){ let msg="Packet download failed."; try{const body=await res.json();msg=body.message||msg;}catch(_){} throw new Error(msg); }
    const blob=await res.blob();
    const name=(p.name||"provider").replace(/[^A-Za-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"")||"provider";
    const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=name+"-credentialing-packet.zip"; document.body.appendChild(a); a.click();
    setTimeout(()=>{URL.revokeObjectURL(url);a.remove();},1000);
    toast("Packet bundle downloaded",`Downloaded the PDF and ${n} associated file${n!==1?'s':''} for ${esc(p.name)}.`,{icon:ICON.file});
  }catch(e){ toast("Packet download failed",esc(e.message||"Something went wrong.")); }
}
// Save a document's expiry / renew-by date (team, licenses).
function saveDrawerExpiry(key){
  const p=sel(); if(!p) return; const d=p.docs[key];
  const el=document.getElementById('drawerExpiry'); if(!el) return;
  d.expiresAt=el.value||"";
  persistReview(d,d.status,d.note||"",d.expiresAt||null);
  const nm=(ALL_KEYS.find(i=>i.key===key)||{}).name||"Document";
  toast("Expiry saved",`${nm}: ${d.expiresAt?fmtDay(new Date(d.expiresAt)):'date cleared'}.`,{icon:ICON.shield});
  renderDrawer();
}
// Popup modal with a custom, styled calendar. Reused everywhere a date is picked.
const CAL_MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];
const CAL_DOW=["Su","Mo","Tu","We","Th","Fr","Sa"];
const CAL_PREV='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
const CAL_NEXT='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
let _cal={sel:"",y:0,m:0,cb:null};
function calFmt(iso){ const d=new Date(iso+"T00:00:00"); return isNaN(d)?"—":d.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"}); }
// Open the stylized date picker. opts:{title,subtitle,note,selectedLabel,value,confirmLabel,
// confirmIcon,headIcon,headBg,headColor,allowClear,onConfirm(isoOrEmpty)}.
function openCalendar(opts){
  opts=opts||{};
  const start=opts.value||new Date().toISOString().slice(0,10);
  const d=new Date(start+"T00:00:00");
  _cal={sel:opts.value||"", y:d.getFullYear(), m:d.getMonth(), mode:"days", cb:opts.onConfirm||null};
  const bg=opts.headBg||'var(--blue-100)', col=opts.headColor||'var(--blue-700)', ic=opts.headIcon||ICON.cal;
  openModal2(`
    <div class="m-h"><div style="width:34px;height:34px;border-radius:9px;background:${bg};color:${col};display:flex;align-items:center;justify-content:center">${ic}</div>
      <div><h3 style="font-size:16px">${esc(opts.title||'Choose a date')}</h3>${opts.subtitle?`<p class="muted small" style="margin-top:2px">${esc(opts.subtitle)}</p>`:''}</div></div>
    <div class="m-b">${opts.note?`<p class="muted small" style="margin-bottom:12px">${esc(opts.note)}</p>`:''}
      <div class="cal-selected"><span class="muted small">${esc(opts.selectedLabel||'Selected date')}</span><div class="cal-selected-date" id="calReadout">${_cal.sel?calFmt(_cal.sel):'—'}</div></div>
      <div id="calWrap"></div></div>
    <div class="m-f">${opts.allowClear?`<button class="btn ghost" data-calclear style="margin-right:auto">Clear date</button>`:''}<button class="btn subtle" data-close2>Cancel</button><button class="btn" data-calconfirm>${opts.confirmIcon?opts.confirmIcon+' ':''}${esc(opts.confirmLabel||'Save date')}</button></div>`);
  renderCalendar();
  const cc=$("#modalRoot2 [data-calconfirm]"); if(cc) cc.onclick=()=>{ const v=_cal.sel; const cb=_cal.cb; closeModal2(); if(cb) cb(v); };
  const clr=$("#modalRoot2 [data-calclear]"); if(clr) clr.onclick=()=>{ const cb=_cal.cb; closeModal2(); if(cb) cb(""); };
}
function renderCalendar(){
  const wrap=document.getElementById("calWrap"); if(!wrap) return;
  const y=_cal.y, m=_cal.m, mode=_cal.mode||"days";
  const sync=()=>{ const ro=document.getElementById("calReadout"); if(ro) ro.textContent=_cal.sel?calFmt(_cal.sel):'—'; };
  // --- Month picker: click the month to jump quickly ---
  if(mode==="months"){
    const cells=CAL_MONTHS.map((mn,i)=>`<button class="cal-cell ${i===m?'sel':''}" data-calmn="${i}">${mn.slice(0,3)}</button>`).join("");
    wrap.innerHTML=`<div class="cal">
      <div class="cal-head"><button class="cal-title cal-title-btn" data-calpicky>${y}</button>
        <div class="cal-nav"><button data-calystep="-1" aria-label="Previous year">${CAL_PREV}</button><button data-calystep="1" aria-label="Next year">${CAL_NEXT}</button></div></div>
      <div class="cal-pick">${cells}</div></div>`;
    wrap.querySelectorAll("[data-calmn]").forEach(b=>b.onclick=()=>{ _cal.m=+b.dataset.calmn; _cal.mode="days"; renderCalendar(); });
    wrap.querySelectorAll("[data-calystep]").forEach(b=>b.onclick=()=>{ _cal.y+=+b.dataset.calystep; renderCalendar(); });
    const py=wrap.querySelector("[data-calpicky]"); if(py) py.onclick=()=>{ _cal.mode="years"; renderCalendar(); };
    return;
  }
  // --- Year picker: click the year to scroll through years ---
  if(mode==="years"){
    const start=y-Math.floor(((y%16)+16)%16); // align a 16-year page
    let cells="";
    for(let yr=start; yr<start+16; yr++) cells+=`<button class="cal-cell ${yr===y?'sel':''}" data-caly="${yr}">${yr}</button>`;
    wrap.innerHTML=`<div class="cal">
      <div class="cal-head"><div class="cal-title">${start} – ${start+15}</div>
        <div class="cal-nav"><button data-calypage="-1" aria-label="Earlier years">${CAL_PREV}</button><button data-calypage="1" aria-label="Later years">${CAL_NEXT}</button></div></div>
      <div class="cal-pick cal-pick-yr">${cells}</div></div>`;
    wrap.querySelectorAll("[data-caly]").forEach(b=>b.onclick=()=>{ _cal.y=+b.dataset.caly; _cal.mode="months"; renderCalendar(); });
    wrap.querySelectorAll("[data-calypage]").forEach(b=>b.onclick=()=>{ _cal.y+=(+b.dataset.calypage)*16; renderCalendar(); });
    return;
  }
  // --- Day grid (default) ---
  const startDow=new Date(y,m,1).getDay();
  const daysInMonth=new Date(y,m+1,0).getDate();
  const todayIso=new Date().toISOString().slice(0,10);
  let cells="";
  for(let i=0;i<startDow;i++) cells+=`<button class="cal-day muted" disabled></button>`;
  for(let dnum=1;dnum<=daysInMonth;dnum++){
    const iso=`${y}-${String(m+1).padStart(2,"0")}-${String(dnum).padStart(2,"0")}`;
    const cls=["cal-day"]; if(iso===_cal.sel)cls.push("sel"); if(iso===todayIso)cls.push("today");
    cells+=`<button class="${cls.join(" ")}" data-calday="${iso}">${dnum}</button>`;
  }
  wrap.innerHTML=`<div class="cal">
    <div class="cal-head"><div class="cal-title-group"><button class="cal-title cal-title-btn" data-calpickm>${CAL_MONTHS[m]}</button><button class="cal-title cal-title-btn" data-calpicky>${y}</button></div>
      <div class="cal-nav"><button data-calnav="prev" aria-label="Previous month">${CAL_PREV}</button><button data-calnav="next" aria-label="Next month">${CAL_NEXT}</button></div></div>
    <div class="cal-grid cal-dow">${CAL_DOW.map(d=>`<div class="cal-dowc">${d}</div>`).join("")}</div>
    <div class="cal-grid">${cells}</div>
    <div class="cal-foot"><button class="cal-link" data-calset="today">Today</button></div>
  </div>`;
  wrap.querySelectorAll("[data-calday]").forEach(b=>b.onclick=()=>{_cal.sel=b.dataset.calday; sync(); renderCalendar();});
  wrap.querySelectorAll("[data-calnav]").forEach(b=>b.onclick=()=>{ if(b.dataset.calnav==="prev"){ if(--_cal.m<0){_cal.m=11;_cal.y--;} } else { if(++_cal.m>11){_cal.m=0;_cal.y++;} } renderCalendar(); });
  const pm=wrap.querySelector("[data-calpickm]"); if(pm) pm.onclick=()=>{ _cal.mode="months"; renderCalendar(); };
  const py=wrap.querySelector("[data-calpicky]"); if(py) py.onclick=()=>{ _cal.mode="years"; renderCalendar(); };
  const t=wrap.querySelector("[data-calset]"); if(t) t.onclick=()=>{ const n=new Date(); _cal.sel=n.toISOString().slice(0,10); _cal.y=n.getFullYear(); _cal.m=n.getMonth(); _cal.mode="days"; sync(); renderCalendar(); };
}
// Expose the stylized picker so the admin console (app.js) can reuse it.
window.openCalendar=openCalendar;
function openActiveModal(){
  const p=sel(); if(!p) return;
  openCalendar({
    title:"Mark deal Active", subtitle:p.name,
    note:"Set the date this provider/patients are seen from. The deal is marked a success from this date forward.",
    selectedLabel:"Active start date",
    value:(p.deal&&p.deal.activeDate)||new Date().toISOString().slice(0,10),
    confirmLabel:"Confirm active", confirmIcon:ICON.shield, headIcon:ICON.shield, headBg:'var(--green-100)', headColor:'var(--green)',
    onConfirm:(v)=>{ if(v) setDealStatus('completed', v); }
  });
}
// Update a provider's deal status (Active date / cancel / reopen).
function setDealStatus(status, activeDateArg){
  const p=sel(); if(!p) return;
  let activeDate=null, reason="";
  if(status==="completed"){ activeDate=activeDateArg||(document.getElementById('dealDate')&&document.getElementById('dealDate').value)||new Date().toISOString().slice(0,10); }
  if(status==="cancelled"){ reason=window.prompt("Reason for cancelling this deal? (optional)")||""; }
  p.deal={status,activeDate:status==='completed'?activeDate:((p.deal&&p.deal.activeDate)||null),reason};
  fetch("/api/providers/"+p.id+"/deal",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({status,activeDate,reason})})
    .then(r=>r.json()).then(res=>{ if(res&&res.deal){ p.deal=res.deal; render(); } }).catch(()=>{});
  const msg=status==="completed"?`Deal marked Active from ${fmtDay(new Date(activeDate))}. This provider/patients are seen from that date forward.`:(status==="cancelled"?"Deal cancelled.":"Deal returned to the pipeline.");
  toast("Deal updated",msg,{icon:ICON.shield});
  render();
}

// Team: toggle a section's gate (hide later sections until complete/acknowledged).
// Applies to every provider, so we update the shared catalog and re-render.
function toggleGate(sectionId){
  const sec=CHECKLIST.find(s=>s.id===sectionId); if(!sec) return;
  const next=!sec.gate; sec.gate=next;
  const src=SECTIONS.find(s=>(s.id||"")===sectionId)||SECTIONS[sec.n-1]; if(src) src.gate=next;
  fetch("/api/catalog/sections/"+sectionId+"/gate",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({gate:next})})
    .then(r=>r.json()).then(res=>{ if(res&&res.catalog) setCatalog(res.catalog.sections); render(); }).catch(()=>{});
  toast(next?"Gate on":"Gate off",next?`Later sections stay hidden until "${sec.title}" is complete or unlocked.`:`Later sections are always visible for "${sec.title}".`,{icon:ICON.lock});
  render();
}
// Team: unlock (acknowledge) or re-lock a gated section for one provider.
function setSectionAck(sectionId,on){
  const p=sel(); if(!p) return;
  const sec=CHECKLIST.find(s=>s.id===sectionId);
  p.sectionAcks=p.sectionAcks||{};
  if(on) p.sectionAcks[sectionId]={by:"",name:teamName(),at:new Date().toISOString()}; else delete p.sectionAcks[sectionId];
  fetch("/api/providers/"+p.id+"/section-ack",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({sectionId,on})})
    .then(r=>r.json()).then(res=>{ if(res&&res.sectionAcks) p.sectionAcks=res.sectionAcks; render(); }).catch(()=>{});
  toast(on?"Sections unlocked":"Sections re-locked",on?`${esc(firstNameOf(p.name))} can now see the sections after "${sec?sec.title:''}".`:`Later sections are hidden again until "${sec?sec.title:''}" is complete.`,{icon:ICON.shield});
  render();
}

/* ============================================================
   Small modal helpers (layer 2)
   ============================================================ */
function openModal2(html){$("#modalRoot2").innerHTML=`<div class="modal-bg" data-bg2><div class="modal">${html}</div></div>`;bindModal2();}
function closeModal2(){$("#modalRoot2").innerHTML="";}
function bindModal2(){
  const root=$("#modalRoot2");
  root.querySelectorAll("[data-close2]").forEach(b=>b.onclick=closeModal2);
  const bg=root.querySelector("[data-bg2]"); if(bg) bg.onclick=e=>{if(e.target===bg)closeModal2();};
  const cp=root.querySelector("[data-confirmprovide]"); if(cp) cp.onclick=()=>confirmProvide(cp.dataset.confirmprovide);
  const cf=root.querySelector("[data-confirmfix]"); if(cf) cf.onclick=()=>confirmFix(cf.dataset.confirmfix);
  const ca=root.querySelector("[data-confirmactive]"); if(ca) ca.onclick=()=>{ setDealStatus('completed'); closeModal2(); };
  const dz=root.querySelector("#dropZone"), fi=root.querySelector("#fileInput"), fc=root.querySelector("#fileChosen");
  if(dz&&fi){
    const show=f=>{ pendingUpload=f||null; if(fc) fc.textContent=f?("Selected: "+f.name):""; };
    dz.onclick=()=>fi.click();
    fi.onchange=()=>show(fi.files&&fi.files[0]);
    ["dragenter","dragover"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add("drag");}));
    ["dragleave","drop"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove("drag");}));
    dz.addEventListener("drop",e=>{ const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0]; if(f) show(f); });
  }
}
function bindDrawer(){
  const root=$("#modalRoot");
  const bg=root.querySelector("[data-bg]"); if(bg) bg.onclick=e=>{if(e.target===bg)closeDrawer();};
  root.querySelectorAll("[data-dclose]").forEach(b=>b.onclick=closeDrawer);
  root.querySelectorAll("[data-drawertab]").forEach(b=>b.onclick=()=>{
    const tab=b.dataset.drawertab;
    state.drawerTab=tab;
    const body=root.querySelector(".drawer-b"); if(body) body.setAttribute("data-dtab",tab);
    root.querySelectorAll("[data-drawertab]").forEach(x=>x.classList.toggle("active",x===b));
    if(tab==="notes"){const st=root.querySelector(".notes-stream"); if(st) st.scrollTop=st.scrollHeight;}
  });
  const ns=root.querySelector("[data-notesend]"); if(ns) ns.onclick=()=>postNote(state.drawer);
  root.querySelectorAll("[data-dreview]").forEach(b=>b.onclick=()=>drawerReview(b.dataset.dreview));
  root.querySelectorAll("[data-setexpiry]").forEach(b=>b.onclick=()=>saveDrawerExpiry(b.dataset.setexpiry));
  root.querySelectorAll("[data-provide]").forEach(b=>b.onclick=()=>openProvide(b.dataset.provide));
  root.querySelectorAll("[data-viewfile]").forEach(b=>b.onclick=()=>{const p=activeP();openFile(p.docs[b.dataset.viewfile]);});
  // Per-file controls (multiple files per document).
  root.querySelectorAll("[data-filereview]").forEach(b=>b.onclick=()=>{const[id,st]=b.dataset.filereview.split("|");reviewFile(id,st);});
  root.querySelectorAll("[data-replacefile]").forEach(b=>b.onclick=()=>{const[k,id]=b.dataset.replacefile.split("|");openProvide(k,id);});
  root.querySelectorAll("[data-deletefile]").forEach(b=>b.onclick=()=>{const[k,id]=b.dataset.deletefile.split("|");deleteFile(k,id);});
  root.querySelectorAll("[data-viewfid]").forEach(b=>b.onclick=()=>openFileById(b.dataset.viewfid));
  root.querySelectorAll("[data-pickexp]").forEach(b=>b.onclick=()=>pickFileExpiry(b.dataset.pickexp));
  // File carousel: one viewer, page through files by index.
  const files=(activeP()&&state.drawer&&activeP().docs[state.drawer]&&activeP().docs[state.drawer].files)||[];
  root.querySelectorAll("[data-fileprev]").forEach(b=>b.onclick=()=>{ state.fileZoom=1; state.fileIdx=(state.fileIdx-1+files.length)%files.length; renderDrawer(); });
  root.querySelectorAll("[data-filenext]").forEach(b=>b.onclick=()=>{ state.fileZoom=1; state.fileIdx=(state.fileIdx+1)%files.length; renderDrawer(); });
  root.querySelectorAll("[data-filego]").forEach(b=>b.onclick=()=>{ state.fileZoom=1; state.fileIdx=+b.dataset.filego||0; renderDrawer(); });
  // Document zoom / magnifier (updates the scale transform without re-rendering).
  root.querySelectorAll("[data-zoom]").forEach(b=>b.onclick=()=>{
    if(b.dataset.zoom==='in') state.fileZoom=Math.min(4,(state.fileZoom||1)+0.25);
    else if(b.dataset.zoom==='out') state.fileZoom=Math.max(0.5,(state.fileZoom||1)-0.25);
    else state.fileZoom=1;
    const wrap=root.querySelector(".fv-scale"); if(wrap) wrap.style.transform="scale("+state.fileZoom+")";
    const lbl=root.querySelector("[data-zoom='reset']"); if(lbl) lbl.textContent=Math.round(state.fileZoom*100)+"%";
  });
  // Custom input fields (non-document info items).
  root.querySelectorAll("[data-savefields]").forEach(b=>b.onclick=()=>saveFields(b.dataset.savefields));
  root.querySelectorAll("[data-fielddate]").forEach(b=>b.onclick=()=>{
    const inp=document.getElementById("fld-"+b.dataset.fielddate); if(!inp) return;
    openCalendar({title:"Select date",selectedLabel:"Date",value:inp.value||"",confirmLabel:"Save date",allowClear:true,onConfirm:(iso)=>{ inp.value=iso||""; b.innerHTML=ICON.cal+" "+(iso||"Set date"); }});
  });
  const ni=$("#noteInput");
  if(ni){ ni.onkeydown=e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();postNote(state.drawer);}};
    ni.oninput=()=>{ni.style.height="42px";ni.style.height=Math.min(ni.scrollHeight,110)+"px";}; }
}

/* ============================================================
   Bind (app level)
   ============================================================ */
function bind(){
  // landing / auth
  app.querySelectorAll("[data-pick]").forEach(el=>el.onclick=()=>{state.authRole=el.dataset.pick;state.authStep="form";state.authMode="login";render();});
  app.querySelectorAll("[data-authstep]").forEach(el=>el.onclick=()=>{state.authStep=el.dataset.authstep;render();});
  app.querySelectorAll("[data-authmode]").forEach(el=>el.onclick=()=>{state.authMode=el.dataset.authmode;render();});
  const as=app.querySelector("[data-authsubmit]"); if(as) as.onclick=()=>setRole(state.authRole);
  // tabs / nav
  app.querySelectorAll("[data-tab]").forEach(el=>el.onclick=()=>{state.physTab=el.dataset.tab;render();});
  app.querySelectorAll("[data-goroster]").forEach(el=>el.onclick=()=>{state.teamView="roster";render();});
  app.querySelectorAll("[data-goreports]").forEach(el=>el.onclick=()=>{state.teamView="reports";render();});
  app.querySelectorAll("[data-dealpick]").forEach(el=>el.onclick=e=>{e.stopPropagation();openActiveModal();});
  app.querySelectorAll("[data-deal]").forEach(el=>el.onclick=e=>{e.stopPropagation();setDealStatus(el.dataset.deal);});
  app.querySelectorAll("[data-rfilter]").forEach(el=>el.onclick=e=>{e.stopPropagation();const k=el.dataset.rfilter;state.rosterFilter=(k==='all')?null:k;render();});
  app.querySelectorAll("[data-dfilter]").forEach(el=>el.onclick=e=>{e.stopPropagation();const k=el.dataset.dfilter;state.detailFilter=(k==='all'||state.detailFilter===k)?null:k;render();});
  app.querySelectorAll("[data-open-p]").forEach(el=>el.onclick=e=>{e.stopPropagation();state.selectedId=el.dataset.openP;state.teamView="detail";state.detailFilter=null;state.activating=false;render();});
  // sections collapse
  app.querySelectorAll("[data-sec]").forEach(el=>el.onclick=()=>{
    const n=+el.dataset.sec;
    const p=state.role==="team"?sel():me();
    const teamMode=state.role==="team"&&state.teamView==="detail";
    const nowCollapsed=isSecCollapsed(p,{n},teamMode,null);
    state.collapsed[n]=!nowCollapsed;
    render();
  });
  // section gate toggle (team) — applies to every provider
  app.querySelectorAll("[data-gate]").forEach(el=>el.onclick=e=>{e.stopPropagation();toggleGate(el.dataset.gate);});
  // acknowledge / re-lock a gated section for one provider (team)
  app.querySelectorAll("[data-ack]").forEach(el=>el.onclick=e=>{e.stopPropagation();const[id,mode]=el.dataset.ack.split("|");setSectionAck(id,mode==="on");});
  // item row open drawer
  app.querySelectorAll(".item[data-open]").forEach(el=>el.onclick=()=>openDrawer(el.dataset.open));
  // action buttons (stop row open)
  app.querySelectorAll("[data-provide]").forEach(el=>el.onclick=e=>{e.stopPropagation();openProvide(el.dataset.provide);});
  app.querySelectorAll("[data-view]").forEach(el=>el.onclick=e=>{e.stopPropagation();openFile(activeP().docs[el.dataset.view]);});
  app.querySelectorAll("[data-access]").forEach(el=>el.onclick=e=>{e.stopPropagation();setAccess(el.dataset.access);});
  app.querySelectorAll("[data-review]").forEach(el=>el.onclick=e=>{e.stopPropagation();const[k,a]=el.dataset.review.split("|");const p=sel();const d=p.docs[k];const list=d.files||[];if(list.length){list.forEach(f=>{if(f.status!=="approved"){f.status="approved";f.note="";fetch("/api/files/"+f.id+"/review",{method:"PATCH",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"approved",note:""})}).catch(()=>{});}});recomputeDoc(d);}else{d.status="approved";d.note="";persistReview(d,"approved","");}toast("Document approved",`${ALL_KEYS.find(i=>i.key===k).name} for ${esc(p.name)} marked approved.`,{icon:ICON.shield});render();});
  app.querySelectorAll("[data-gather]").forEach(el=>el.onclick=async e=>{
    e.stopPropagation();
    if(el.disabled) return;
    const original=el.innerHTML;
    el.disabled=true; el.setAttribute("aria-busy","true"); el.classList.add("is-loading");
    el.innerHTML='<span class="packet-spinner" aria-hidden="true"></span><span>Preparing...</span>';
    try{ await gather(el.dataset.gather); }
    finally{ el.innerHTML=original; el.disabled=false; el.removeAttribute("aria-busy"); el.classList.remove("is-loading"); }
  });
}


function applyIdentity(identity, opts){
  state.identity=identity;
  state.source=(opts&&opts.mode)==="internal"?"internal":"providers";
  const canReview = identity.permissions.includes('portal.review');
  const canInternal = identity.permissions.includes('internal.review');
  if(state.source==="internal"&&canInternal){ state.role='team'; state.view='team'; if(state.teamView==="reports") state.teamView="roster"; }
  else if(canReview){ state.role='team'; state.view='team'; state.teamView='roster'; }
  else {
    state.role='physician'; state.view='portal'; state.physTab='checklist';
    // Build this physician's own profile from their identity (no sample data).
    const id = identity.id || 'me';
    state.meId = id; state.selectedId = id;
    let meP = state.physicians.find(p=>p.id===id);
    if(!meP){
      meP = { id, name:'', specialty:'', email:'', npi:'', phone:'', location:'', init:'', docs:docState({}) };
      state.physicians.push(meP);
    }
    meP.name = identity.displayName || identity.email || 'Physician';
    meP.email = identity.email || meP.email;
    meP.init = initialsOf(identity.displayName || identity.email);
  }
  state.canManageUsers = identity.permissions.includes('users.manage')||identity.permissions.includes('users.view');
}

/* ============================================================
   Backend data loading (real signed-up physicians + documents)
   ============================================================ */
async function apiGet(path){
  try{ const r=await fetch(path,{credentials:"same-origin"}); if(!r.ok) return null; return await r.json(); }
  catch(_){ return null; }
}
function fmtDate(iso){
  if(!iso) return "";
  const d=new Date(iso); if(isNaN(d)) return "";
  return d.toLocaleDateString("en-US",{month:"short",day:"numeric"});
}
// Turn a stored file record into one entry of a document's files[] list.
function fileEntry(f){
  return { id:f.id, name:f.name, url:f.url, mime:f.mime, inline:f.inline, office:f.office,
    status:f.status||"pending", note:f.note||"", expiresAt:f.expiresAt||"",
    updated:fmtDate(f.createdAt), updatedIso:f.createdAt||"" };
}
// A document's overall status derived from all of its files.
function aggStatus(list){
  if(!list.length) return "missing";
  if(list.some(f=>f.status==="attention")) return "attention";
  if(list.some(f=>f.status==="pending")) return "pending";
  return "approved";
}
// Reconstruct a physician's document state from their uploaded files.
// A document can hold MANY files; each is tracked/reviewed individually and the
// row shows the aggregate status. listByOwner returns newest-first.
function buildDocs(fileList, fieldList){
  const d=docState({});
  const groups={};
  (fileList||[]).forEach(f=>{
    if(!f.docKey || d[f.docKey]===undefined) return;
    (groups[f.docKey]=groups[f.docKey]||[]).push(f);
  });
  Object.keys(groups).forEach(key=>{
    const list=groups[key].map(fileEntry);
    const primary=list[0];
    d[key]=Object.assign({}, d[key], {
      files:list, status:aggStatus(list),
      file:primary.name, fileId:primary.id, fileUrl:primary.url, mime:primary.mime,
      inline:primary.inline, office:primary.office, updated:primary.updated, updatedIso:primary.updatedIso,
      expiresAt:primary.expiresAt, note:primary.note, notes:[],
      notif:{physician:false, team:list.some(f=>f.status==="pending")}
    });
  });
  // Hydrate saved non-document field values + authorship (persisted server-side,
  // so the physician and the whole team see the same data).
  (fieldList||[]).forEach(r=>{
    if(!r.docKey || d[r.docKey]===undefined) return;
    d[r.docKey].fieldValues=r.values||{};
    d[r.docKey].fieldMeta=r.meta||{};
    const anyVal=Object.keys(r.values||{}).some(k=>String(r.values[k]||"").trim());
    if(anyVal && d[r.docKey].status==="missing") d[r.docKey].status="pending";
  });
  return d;
}
// Persist a team review outcome to the backend (only real uploaded files).
function persistReview(d, status, note, expiresAt){
  if(!d || !d.fileId) return;
  const body={status,note:note||""}; if(expiresAt!==undefined) body.expiresAt=expiresAt;
  fetch("/api/files/"+d.fileId+"/review",{method:"PATCH",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).catch(()=>{});
}
async function loadData(){
  const cat=await apiGet(internalMode()?"/api/internal/catalog":"/api/catalog"); if(cat&&cat.catalog) setCatalog(cat.catalog.sections);
  if(state.role==="team"){
    const data=await apiGet(internalMode()?"/api/internal/employees":"/api/physicians"); if(!data) return;
    const list=internalMode()?(data.employees||[]):(data.physicians||[]);
    state.physicians=list.map(p=>({
      id:p.id, name:p.displayName||p.username||p.email||(internalMode()?"Employee":"Physician"), specialty:internalMode()?(p.email||p.username||""):"",
      email:p.email||"", npi:"", phone:"", location:"", init:initialsOf(p.displayName||p.username||p.email),
      deal:p.deal||{status:"pending",activeDate:null}, sectionAcks:p.sectionAcks||{}, docs:buildDocs(p.files,p.fields)
    }));
    render();
    restoreDrawer();
  } else if(state.role==="physician"){
    const data=await apiGet("/api/my/files"); if(!data) return;
    const meP=me(); if(meP){ meP.sectionAcks=data.sectionAcks||{}; meP.docs=buildDocs(data.files,data.fields); render(); restoreDrawer(); }
  }
}
window.Portal = { render:function(container, identity, opts){ app=container; applyIdentity(identity, opts||{}); restoreNav(); render(); loadData(); }, currentRole:function(){return state.role;} };


})();
