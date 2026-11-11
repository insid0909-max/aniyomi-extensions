// 일반 브라우저 DOM 기반 실험판. API 주소 추측·TS 단독 반환·DRM 우회 없음.
const mangayomiSources=[{id:1543279647,name:"[시험] 라트펠",lang:"ko",baseUrl:"https://latfel.net",version:"0.0.1",isNsfw:false,hasCloudflare:false,itemType:1,isManga:false}];
const LF_BASE="https://latfel.net",LF_UA="Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
function lfPath(value){const s=String(value||"");if(/^https?:/i.test(s)&&!/^https:\/\/latfel\.net\//i.test(s))throw new Error("라트펠 주소가 아닙니다.");if(/[\\\r\n]/.test(s))throw new Error("잘못된 경로입니다.");const p=s.replace(/^https:\/\/latfel\.net/i,"");if(!/^\/(?:item\/\d+|[^\s?#]*)(?:[?#][^\s]*)?$/.test(p)||p.startsWith("//"))throw new Error("올바른 사이트 경로가 아닙니다.");return p;}
function lfPage(p){if(!Number.isSafeInteger(p)||p<1)throw new Error("올바른 페이지 번호가 아닙니다.");return p;}
function lfMedia(url){return /^https?:\/\/[^\s<>"']+/i.test(url)&&/\.(?:m3u8|mp4)$/i.test(url.split(/[?#]/)[0])&&!/[\r\n]/.test(url);}
function lfManifest(body){const s=String(body||"").replace(/^\uFEFF/,"").trim();return /^#EXTM3U(?:\r?\n|$)/.test(s)&&/#EXT(?:INF:|-X-STREAM-INF:)/.test(s)&&!/#EXT-X-(?:KEY|SESSION-KEY):[^\r\n]*(?:METHOD=SAMPLE-AES|KEYFORMAT="(?!identity")|skd:)/i.test(s);}
class DefaultExtension extends MProvider{
 get baseUrl(){return LF_BASE;} get supportsLatest(){return false;}
 getHeaders(){return {"User-Agent":LF_UA,Referer:LF_BASE+"/"};}
 getSourcePreferences(){return [];} getFilterList(){return [];}
 async run(path,kind,data={}){
  const script="("+latfelTask.toString()+")("+JSON.stringify(kind)+","+JSON.stringify(data)+")";
  let raw;if(typeof sendMessage==="function")raw=await sendMessage("evaluateJavascriptViaWebview",JSON.stringify([LF_BASE+lfPath(path),this.getHeaders(),[script],55]));
  else if(typeof evaluateJavascriptViaWebview==="function")raw=await evaluateJavascriptViaWebview(LF_BASE+lfPath(path),this.getHeaders(),[script],55);
  else throw new Error("이 앱에서 웹뷰 실행 기능을 찾지 못했습니다.");
  if(!raw)throw new Error("웹뷰 응답 시간 초과. 사이트를 웹뷰에서 먼저 확인하세요.");
  let result;try{result=typeof raw==="string"?JSON.parse(raw):raw;}catch(e){throw new Error("웹뷰 응답을 해석하지 못했습니다.");}
  if(!result||result.error)throw new Error(result?.error||"웹뷰 응답이 비어 있습니다.");return result;
 }
 async getPopular(page){lfPage(page);if(page>1)return {list:[],hasNextPage:false};return {list:(await this.run("/","list")).list,hasNextPage:false};}
 async getLatestUpdates(page){return this.getPopular(page);}
 async search(query,page,filters){lfPage(page);if(page>1)return {list:[],hasNextPage:false};return {list:(await this.run("/","search",{query:String(query||"").trim()})).list,hasNextPage:false};}
 async getDetail(url){const path=lfPath(url).split(/[?#]/)[0];if(!/^\/item\/\d+$/.test(path))throw new Error("작품 주소가 아닙니다.");return await this.run(path,"detail");}
 async getVideoList(url){
  const path=lfPath(url),mark="#lf-action=",i=path.indexOf(mark);let action={};if(i>=0){try{action=JSON.parse(decodeURIComponent(path.slice(i+mark.length)));}catch(e){throw new Error("회차 정보를 다시 불러오세요.");}}
  const result=await this.run(i>=0?path.slice(0,i):path,"video",action),videos=[];
  for(const item of result.candidates||[]){if(!lfMedia(item.url))continue;const h={...this.getHeaders(),Referer:item.referer||LF_BASE+"/"};
   if(/\.m3u8$/i.test(item.url.split(/[?#]/)[0])){try{const r=await new Client({timeout:7,connectTimeout:5}).get(item.url,h);if(r.statusCode!==200||!lfManifest(r.body))continue;}catch(e){continue;}}
   else if(item.kind!=="video")continue;
   if(!videos.some(x=>x.url===item.url))videos.push({url:item.url,originalUrl:item.url,quality:/\.m3u8$/i.test(item.url.split(/[?#]/)[0])?"자동 (HLS)":"MP4",headers:h});
  }
  if(!videos.length)throw new Error("완전한 HLS/MP4 주소를 검증하지 못했습니다. blob·TS 조각·DRM 영상은 반환하지 않습니다.");return videos;
 }
}
function latfelTask(kind,data){
 if(location.origin!=="https://latfel.net"){window.flutter_inappwebview.callHandler("setResponse",JSON.stringify({error:"라트펠 외부 주소로 이동했습니다."}));return;}
 if(window.__lfTaskActive)return;window.__lfTaskActive=true;
 let done=false,ticks=0,searchSent=false,clicked=false,last="",stable=0;const started=Date.now();
 const text=e=>(e?.innerText||e?.textContent||"").replace(/\s+/g," ").trim();
 const visible=e=>!!e&&!!(e.getClientRects().length)&&getComputedStyle(e).visibility!=="hidden";
 const absolute=(s,base=location.href)=>{if(!String(s||"").trim())return "";try{const u=new URL(s,base);return /^https?:$/.test(u.protocol)?u.href:"";}catch(e){return "";}};
 const enabled=e=>!e.disabled&&e.getAttribute("aria-disabled")!=="true"&&!/재생\s*불가/.test(text(e));
 const epName=s=>/^(?:제\s*)?\d+(?:\.\d+)?\s*(?:화|회)(?:\s|[:.\-]|$)|^(?:특별편|프롤로그|OVA|OAD|SP|PV)(?:\s|[:.\-]|$)/i.test(s);
 const finish=result=>{if(done)return;done=true;clearInterval(timer);window.__lfTaskActive=false;window.flutter_inappwebview.callHandler("setResponse",JSON.stringify(result));};
 function cards(){const map=new Map();for(const a of document.querySelectorAll("a[href]")){const url=absolute(a.getAttribute("href"));let u;try{u=new URL(url);}catch(e){continue;}if(u.origin!==location.origin||!/^\/item\/\d+\/?$/.test(u.pathname)||!visible(a))continue;
 const image=a.querySelector("img"),title=a.querySelector("[class*='title'],h2,h3,h4"),name=text(title)||a.getAttribute("title")||image?.alt||text(a).replace(/재생\s*(?:불가|가능)|완결/g,"").trim();if(!name)continue;
 if(!map.has(u.pathname))map.set(u.pathname,{name,link:u.pathname,imageUrl:absolute(image?.currentSrc||image?.getAttribute("src")||image?.getAttribute("data-src")||"")});}return [...map.values()];}
 function chapters(){const map=new Map();for(const a of document.querySelectorAll("main a[href],article a[href],a[href]")){const name=text(a);if(!visible(a)||!enabled(a)||!epName(name))continue;const href=absolute(a.getAttribute("href"));let u;try{u=new URL(href);}catch(e){continue;}if(u.origin!==location.origin||u.pathname===location.pathname||u.pathname==="/")continue;map.set(u.href,{name,url:u.pathname+u.search});}
 for(const b of document.querySelectorAll("button,[role='button']")){const name=text(b);if(!visible(b)||!enabled(b)||!epName(name))continue;const url=location.pathname+"#lf-action="+encodeURIComponent(JSON.stringify({label:name}));map.set(url,{name,url});}return [...map.values()];}
 function media(){const found=new Map();let drm=false;
 function visit(w,depth){if(depth>3)return;try{const doc=w.document,ref=w.location.href;for(const v of doc.querySelectorAll("video")){if(v.mediaKeys){drm=true;continue;}if(v.paused){try{const p=v.play();if(p?.catch)p.catch(()=>{});}catch(e){}}
 for(const s of [v.currentSrc,v.src,...[...v.querySelectorAll("source[src]")].map(x=>x.src)]){const u=absolute(s||"",ref);if(u&&/\.(?:m3u8|mp4)$/i.test(u.split(/[?#]/)[0]))found.set(u,{url:u,kind:"video",referer:ref});}}
 for(const r of w.performance.getEntriesByType("resource")){const u=absolute(r.name,ref);if(/\.m3u8$/i.test(u.split(/[?#]/)[0])&&!found.has(u))found.set(u,{url:u,kind:"resource",referer:ref});}for(const frame of doc.querySelectorAll("iframe")){try{visit(frame.contentWindow,depth+1);}catch(e){}}}catch(e){}}
 visit(window,0);return {drm,candidates:[...found.values()].slice(0,4)};}
 const timer=setInterval(()=>{if(done)return;try{ticks++;
  if(kind==="search"&&data.query&&!searchSent){let input=[...document.querySelectorAll("input")].find(e=>visible(e)&&(e.type==="search"||/검색|search/i.test((e.placeholder||"")+" "+(e.getAttribute("aria-label")||""))));
   if(!input){const opener=document.querySelector("button[aria-label*='검색'],button[title*='검색']");if(opener&&visible(opener))opener.click();}
   else{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set;setter?setter.call(input,data.query):input.value=data.query;input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}));input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",bubbles:true}));if(input.form?.requestSubmit)input.form.requestSubmit();searchSent=true;}}
  if(kind==="list"||kind==="search"){let list=cards();if(kind==="search"&&data.query){list=list.filter(x=>x.name.toLowerCase().includes(data.query.toLowerCase()));if(!searchSent)list=[];}const fingerprint=JSON.stringify(list);stable=fingerprint===last?stable+1:0;last=fingerprint;if(list.length&&stable>=4&&Date.now()-started>=1500)return finish({list});if(kind==="search"&&searchSent&&/검색\s*결과(?:가)?\s*(?:없|0)|결과가 없습니다/.test(document.body.innerText))return finish({list:[]});}
  if(kind==="detail"){const eps=chapters(),hs=[...document.querySelectorAll("h1")].filter(e=>visible(e)&&! /^(설정|검색|로그인)$/.test(text(e))),name=text(hs[0]);if(name&&eps.length&&ticks>=6)return finish({name,link:location.pathname,imageUrl:absolute(document.querySelector("meta[property='og:image']")?.content||""),description:document.querySelector("meta[property='og:description'],meta[name='description']")?.content||"",genre:[],chapters:eps});}
  if(kind==="video"){if(data.label&&!clicked){const target=[...document.querySelectorAll("button,[role='button']")].find(e=>visible(e)&&enabled(e)&&text(e)===data.label);if(target){target.click();clicked=true;}}if(!data.label||clicked){const m=media();if(m.drm)return finish({error:"DRM 보호 영상입니다. 사이트의 정식 플레이어를 이용해야 합니다."});if(m.candidates.length&&ticks>=8)return finish(m);}}
  if(ticks>=120){const page=location.origin+location.pathname;finish({error:"라트펠 "+kind+" 정보를 찾지 못했습니다 ("+page+"). 일반 페이지 DOM·회차 버튼·재생 권한을 확인해야 합니다. 크롤러 페이지나 교차 출처 프레임은 처리되지 않을 수 있습니다."});}
 }catch(e){finish({error:"라트펠 웹뷰 분석 오류: "+String(e.message||e).slice(0,180)});}},250);
}
