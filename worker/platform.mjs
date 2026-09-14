import { createHash, createHmac, randomUUID } from 'node:crypto';

export function formatLocal(date, zone, pattern) {
  const d = new Date(date);
  if (!Number.isFinite(d.getTime())) throw new Error('VALIDATION: Invalid date.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(d).map(p=>[p.type,p.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`, time = `${parts.hour}:${parts.minute}`;
  const local = Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second);
  const offset = Math.round((local - Math.floor(d.getTime()/1000)*1000)/60000);
  const zoneOffset = `${offset<0?'-':'+'}${String(Math.floor(Math.abs(offset)/60)).padStart(2,'0')}${String(Math.abs(offset)%60).padStart(2,'0')}`;
  if (pattern === 'yyyy-MM-dd') return day;
  if (pattern === 'HH:mm') return time;
  if (pattern === 'Z') return zoneOffset;
  if (pattern === 'yyyy-MM-dd HH:mm') return `${day} ${time}`;
  if (pattern === 'yyyyMMdd-HHmmss') return day.replaceAll('-','')+'-'+time.replace(':','')+parts.second;
  if (pattern === "yyyy-MM-dd'T'HH:mm:ssXXX") return `${day}T${time}:${parts.second}${zoneOffset.slice(0,3)}:${zoneOffset.slice(3)}`;
  throw new Error('VALIDATION: Unsupported date format.');
}

export function createPlatform(snapshot, owner) {
  if (!owner?.id || owner.id !== snapshot.ownerId) throw new Error('ACCESS_DENIED: Workspace owner mismatch.');
  const originalProperties = structuredClone(snapshot.properties || {});
  const properties = {...originalProperties,SCHEMA_VERSION:'4',DATA_TIMEZONE:originalProperties.DATA_TIMEZONE||'Asia/Manila',SPREADSHEET_ID:snapshot.sourceSheetId,OWNER_USER_ID:owner.id,OWNER_EMAIL:owner.email};
  const transientKeys = new Set(['OWNER_EMAIL','OWNER_USER_ID']);
  const propertiesApi = {getProperty:k=>properties[k]??null,setProperty:(k,v)=>{properties[k]=String(v);return propertiesApi;},deleteProperty:k=>{delete properties[k];return propertiesApi;},getProperties:()=>({...properties})};
  const sheets = new Map(), touched = new Set();
  const fail = () => {throw new Error('SETUP: This integration is handled by the Cloudflare API.');};
  class Range {
    constructor(sheet,row,col,height=1,width=1){if(!Number.isInteger(row)||row<1||!Number.isInteger(col)||col<1||height<0||width<1)throw Error('VALIDATION: Invalid record range.');Object.assign(this,{sheet,row,col,height,width});}
    getValues(){return Array.from({length:this.height},(_,r)=>Array.from({length:this.width},(_,c)=>this.sheet.data[this.row+r-1]?.[this.col+c-1]??''));}
    getFormulas(){return Array.from({length:this.height},()=>Array(this.width).fill(''));}
    setValues(rows){if(rows.length!==this.height||rows.some(row=>row.length!==this.width))throw Error('VALIDATION: Invalid record block.');rows.forEach((row,r)=>{const at=this.row+r-1;this.sheet.data[at]||=[];row.forEach((v,c)=>this.sheet.data[at][this.col+c-1]=v);if(at>0)touched.add(this.sheet.entity+'|'+(at+1));});return this;}
    setValue(v){return this.setValues([[v]]);}
    clearContent(){return this.setValues(Array.from({length:this.height},()=>Array(this.width).fill('')));}
    setFontWeight(){return this;} setBackground(){return this;} setNumberFormat(){return this;} setDataValidation(){return this;} protect(){return this;} setDescription(){return this;} setWarningOnly(){return this;}
  }
  class Sheet {
    constructor(entity,columns,records){this.entity=entity;this.columns=columns;this.data=[columns];this.original=new Map();for(let i=0;i<records.length;i++){const r=records[i],slot=r._slot||i+2,clean={...r};delete clean._slot;if(slot<2||!Number.isInteger(slot))throw Error('SCHEMA: Invalid record position.');this.data[slot-1]=columns.map(c=>r[c]??'');this.original.set(slot,clean);}this.initialLast=Math.max(this.data.length,snapshot.maxSlots?.[entity]||1);this.maxRows=Math.max(1000,this.initialLast);}
    getName(){return 'CC_'+this.entity;} getRange(...args){return new Range(this,...args);} getLastRow(){let n=this.data.length;while(n&&!(this.data[n-1]||[]).some(v=>v!==''))n--;return Math.max(n,this.initialLast);} getLastColumn(){return this.columns.length;} getMaxRows(){return this.maxRows;} insertRowsAfter(_,n){this.maxRows+=n;} setFrozenRows(){}
  }
  const book={getId:()=>snapshot.sourceSheetId,getSheetByName:name=>sheets.get(name),getSheets:()=>[...sheets.values()]};
  const builder={requireValueInList(){return this;},setAllowInvalid(){return this;},build(){return {};}};
  const unavailable=new Proxy({}, {get:()=>fail});
  return {
    initialize(schema,common){for(const [entity,fields]of Object.entries(schema)){const records=snapshot.tables?.[entity]||[];sheets.set('CC_'+entity,new Sheet(entity,common.concat(fields.split(' ')),records));}},
    changes(){const changes=[];for(const entry of touched){const split=entry.lastIndexOf('|'),entity=entry.slice(0,split),slot=+entry.slice(split+1),s=sheets.get('CC_'+entity),v=s.data[slot-1]||[],before=s.original.get(slot)||null,after=v.some(x=>x!=='')?Object.fromEntries(s.columns.map((c,i)=>[c,v[i]??''])):null;if(JSON.stringify(before)!==JSON.stringify(after))changes.push({entity,slot,before,after});}return changes;},
    properties(){return Object.fromEntries(Object.entries(properties).filter(([k])=>!transientKeys.has(k)));},
    snapshot(){return Object.fromEntries([...sheets.values()].map(s=>[s.entity,s.data.slice(1).flatMap((v,i)=>v?.some(x=>x!=='')?[{...Object.fromEntries(s.columns.map((k,j)=>[k,v[j]??''])),_slot:i+2}]:[])]));},
    PropertiesService:{getScriptProperties:()=>propertiesApi},Session:{getActiveUser:()=>({getEmail:()=>owner.email}),getEffectiveUser:()=>({getEmail:()=>owner.email})},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
    Utilities:{getUuid:()=>randomUUID(),DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_,v)=>[...createHash('sha256').update(String(v)).digest()],computeHmacSha256Signature:(v,key)=>[...createHmac('sha256',key).update(v).digest()],formatDate:formatLocal,parseCsv:parseCsv},
    SpreadsheetApp:{openById:()=>book,getActiveSpreadsheet:()=>book,newDataValidation:()=>builder,flush(){}},ScriptApp:{getProjectTriggers:()=>[]},ContentService:unavailable,Calendar:new Proxy({},{get:()=>unavailable}),HtmlService:unavailable
  };
}

export function parseCsv(text){const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}else cell+=c;}if(quoted)throw Error('IMPORT: Unclosed CSV quotation.');if(cell||row.length){row.push(cell);rows.push(row);}return rows;}
