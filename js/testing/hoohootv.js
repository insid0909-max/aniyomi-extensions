const mangayomiSources=[{id:1543279662,name:"[시험] 후후티비",lang:"ko",baseUrl:"https://hu.hoohootv483.xyz",version:"0.0.21",isNsfw:false,itemType:1,isManga:false}];
const HH_UA="Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const HH_CATS=[["TV 전체","/tv/all"],["드라마","/tv/드라마"],["예능","/tv/Reality"],["토크쇼","/tv/Talk"],["TV 코미디","/tv/코미디"],["TV 애니메이션","/tv/애니메이션"],["TV 다큐멘터리","/tv/다큐멘터리"],["키즈","/tv/Kids"],["영화 전체","/movie/all"],["영화 - 액션","/movie/액션"],["영화 - 코미디","/movie/코미디"],["영화 - 스릴러","/movie/스릴러"],["영화 - 로맨스","/movie/로맨스"],["영화 - 공포","/movie/공포"],["영화 - 범죄","/movie/범죄"],["영화 - 애니메이션","/movie/애니메이션"],["영화 - 다큐멘터리","/movie/다큐멘터리"]];
const first=(n,s)=>{const a=n?n.select(s):[];return a.length?a[0]:null},attr=(n,k)=>String(n?.attr(k)||"").trim(),text=n=>String(n?.text||"").replace(/\s+/g," ").trim(),decode=s=>String(s||"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#0?39;/g,"'").replace(/\\\//g,"/"),origin=u=>/^https?:\/\/[^/?#]+/i.exec(String(u||""))?.[0]||"",site=u=>/^https:\/\/[a-z]{2}\.hoohootv\d+\.xyz$/i.test(String(u));
function absolute(b,v){const u=decode(v).trim();if(/^https?:\/\//i.test(u))return u;if(u.startsWith("//"))return "https:"+u;if(!u||u.startsWith("#")||/^[a-z][a-z0-9+.-]*:/i.test(u))return "";const o=origin(b),p=u.startsWith("/")?u:b.slice(o.length).replace(/[?#].*$/,"").replace(/[^/]*$/,"")+u,a=[];for(const x of p.split("/")){if(x==="..")a.pop();else if(x&&x!==".")a.push(x)}return o+"/"+a.join("/")}
function detail(u){const m=/\/detail\/([A-Za-z0-9_-]+)\/?/.exec(String(u||""));if(!m)throw Error("작품 주소 오류");return "/detail/"+m[1]+"/"}
function date(s){const m=/(20\d{2})[-.](\d{1,2})[-.](\d{1,2})/.exec(String(s||""));if(!m)return null;const t=Date.UTC(+m[1],+m[2]-1,+m[3]),d=new Date(t);return d.getUTCFullYear()===+m[1]&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[3]?String(t-32400000):null}
function episodes(html){const m=/<script\b(?=[^>]*\bid\s*=\s*["']episodes-data["'])[^>]*>([\s\S]*?)<\/script\s*>/i.exec(html);if(!m)throw Error("회차 JSON(episodes-data)이 없습니다.");let d;try{d=JSON.parse(m[1])}catch(_){throw Error("회차 JSON 형식 오류")}const map=new Map();for(const k of Object.keys(d||{}))for(const e of Array.isArray(d[k])?d[k]:[]){if(e.episode==null)continue;const season=Number(k)||1,episode=String(e.episode),day=date(e.date)||date(e.label),id=season+":"+episode,old=map.get(id);if(!old||(!old.date&&day))map.set(id,{season,episode,label:String(e.label||episode+"화"),date:day})}return [...map.values()].sort((a,b)=>a.season-b.season||Number(a.episode)-Number(b.episode)||a.episode.localeCompare(b.episode))}
function jwObserve(){let done=false,n=0,play=false,last="";const urls=[],tracks=[],children=[],timeline=[],errors=[],started=Date.now();const cut=u=>String(u||"").split(/[?#]/)[0],err=(stage,e)=>{const s=stage+": "+String(e?.name||"Error")+" "+String(e?.message||e||"");if(!errors.includes(s)&&errors.length<8)errors.push(s)};function state(){const frames=[];for(const f of document.querySelectorAll("iframe")){const o={src:cut(f.src),url:"",readyState:"",access:""};try{const w=f.contentWindow;if(w){o.url=cut(w.location.href);o.readyState=w.document.readyState;o.access="same-origin"}else o.access="no-window"}catch(e){o.access=e.name||"restricted"}frames.push(o);if(frames.length>=4)break}return {url:cut(location.href),readyState:String(document.readyState||""),title:String(document.title||"").slice(0,80),referrer:cut(document.referrer),topLevel:window===window.top,scriptCount:document.scripts?.length||0,frameCount:document.querySelectorAll("iframe").length,frames}}
try{window.addEventListener("error",e=>err("JS",e.error||{name:"Error",message:e.message}));window.addEventListener("unhandledrejection",e=>err("Promise",e.reason))}catch(e){err("listeners",e)}
function add(u,explicit){try{u=new URL(String(u||""),location.href).href;if(!/^https?:/.test(u))return;const p=u.split(/[?#]/)[0];if((/\.m3u8$/i.test(p)||explicit)&&!urls.some(x=>x.url===u))urls.push({url:u,explicit:!!explicit});const m=/[?&]mu=([^&]+)/i.exec(u);if(m)add(decodeURIComponent(m[1].replace(/\+/g," ")),false)}catch(e){err("URL",e)}}
function item(x){if(!x)return;add(x.file,x.type==="hls");for(const s of x.sources||[])add(s.file,s.type==="hls"||/mpegurl/i.test(s.type||""));for(const t of x.tracks||[])if(/^(?:captions|subtitles)$/.test(t.kind||"")){try{const u=new URL(t.file,location.href).href;if(/^https?:/.test(u)&&!tracks.some(x=>x.file===u))tracks.push({file:u,label:String(t.label||"자막")})}catch(e){err("subtitle",e)}}}
function tick(){if(done)return;n++;let jw=false;try{if(typeof jwplayer==="function"){const p=jwplayer();jw=!!p;if(p){item(p.getPlaylistItem&&p.getPlaylistItem());for(const x of p.getPlaylist&&p.getPlaylist()||[])item(x);if(!play&&p.setMute&&p.play){play=true;p.setMute(true);p.play()}}}}catch(e){err("JW",e)}try{for(const v of document.querySelectorAll("video")){add(v.currentSrc,false);add(v.src,false);if(!v.__hhPlay){v.__hhPlay=true;v.muted=true;const p=v.play();if(p&&p.catch)p.catch(e=>err("video play",e))}}for(const s of document.querySelectorAll("video source[src]"))add(s.src,/mpegurl/i.test(s.type||""));for(const e of performance.getEntriesByType("resource"))add(e.name,false);for(const f of document.querySelectorAll("iframe")){const u=f.src;if(/^https?:/.test(u)&&!children.includes(u))children.push(u)}}catch(e){err("scan",e)}let page;try{page=state();const key=JSON.stringify([page.url,page.readyState,page.title,page.frameCount,jw]);if(key!==last){last=key;timeline.push({ms:Date.now()-started,url:page.url,readyState:page.readyState});if(timeline.length>6)timeline.shift()}}catch(e){err("state",e);page={url:cut(location.href),readyState:"state-error"}}if((urls.length||n>=35)&&window.flutter_inappwebview&&window.flutter_inappwebview.callHandler){done=true;window.flutter_inappwebview.callHandler("setResponse",JSON.stringify({urls:urls.slice(0,4),subtitles:tracks.slice(0,8),children:children.slice(0,4),ua:navigator.userAgent,jw,videoCount:document.querySelectorAll("video").length,page,timeline,errors}));return}if(n<40)setTimeout(tick,350)}tick()}
class DefaultExtension extends MProvider{
pref(k,d=""){try{return String(new SharedPreferences().get("hh_test_"+k)??d)}catch(_){return d}}
save(k,v){try{new SharedPreferences().setString("hh_test_"+k,String(v))}catch(_){}}
getBaseUrl(){const m=this.pref("domain").trim().replace(/\/+$/,"");if(m&&!site(m))throw Error("후후티비의 https 주소를 입력해 주세요.");const a=this.pref("auto_domain");return m||this._site||(site(a)?a:mangayomiSources[0].baseUrl)}
get client(){return this._client||(this._client=new Client({timeout:6,connectTimeout:4}))}
getHeaders(u){const o=origin(u)||this.getBaseUrl();return {"User-Agent":HH_UA,Referer:o+"/"}}
async request(u,r){const h={Referer:r||this.getBaseUrl()+"/"};try{return await this.client.get(u,h)}catch(_){return this.client.get(u,{...h,"User-Agent":HH_UA})}}
async adopt(u){if(!site(u))return false;const r=await this.request(u+"/home",u+"/");if(Number(r.statusCode)!==200||!String(r.body).includes("/detail/"))return false;this._site=u;this.save("auto_domain",u);this._cache?.clear();return true}
async discover(){if(this.pref("auto","true")==="false"||this.pref("domain")||Date.now()-Number(this.pref("discover_at","0"))<60000)return false;this.save("discover_at",Date.now());try{const r=await this.request("https://telegra.ph/%ED%9B%84%ED%9B%84%ED%8B%B0%EB%B9%84-%EC%B5%9C%EC%8B%A0-%EC%A3%BC%EC%86%8C-09-03"),a=[...new Set(String(r.body||"").match(/https:\/\/[a-z]{2}\.hoohootv\d+\.xyz/gi)||[])];for(const u of a.slice(0,3))if(u!==this.getBaseUrl()&&await this.adopt(u))return true}catch(_){}return false}
async html(p,page=1){let r;try{r=await this.request(this.getBaseUrl()+String(p).replace(/[^\x00-\x7f]+/g,encodeURIComponent))}catch(_){if(await this.discover())return this.html(p,page);throw Error("후후티비 연결 실패. 현재 주소를 확인해 주세요. ["+String((_&&_.message)||_).replace(/\s+/g," ").substring(0,90)+"]")}const s=Number(r.statusCode),b=String(r.body||"");if(s===451)throw Error("HTTP 451: 접근이 제한되었습니다.");if(s===403||/<title>\s*Just a moment|id=["']cf-chl/i.test(b))throw Error("웹뷰에서 사이트 인증을 직접 확인해 주세요.");if(s===404&&page>1)return "";if(s>=500&&await this.discover())return this.html(p,page);if(s!==200)throw Error("후후티비 HTTP "+s);return b}
cards(h){const out=[],seen=new Set();for(const box of new Document(h).select("li")){const a=first(box,"a.thumb[href*='/detail/']")||first(box,"a[href*='/detail/']"),i=first(a,"img");if(!a||!i)continue;let link;try{link=detail(attr(a,"href"))}catch(_){continue}const name=text(first(box,".subject a"))||attr(i,"alt")||attr(a,"title");if(!name||seen.has(link))continue;seen.add(link);out.push({name,link,imageUrl:absolute(this.getBaseUrl()+"/",attr(i,"data-src")||attr(i,"src"))})}return out}
async listing(p,n){if(!Number.isSafeInteger(n)||n<1)throw Error("목록 페이지 오류");const c=this._cache||(this._cache=new Map()),k=p+"|"+n,h=c.get(k);if(h&&Date.now()-h.t<300000)return h.v;const b=await this.html(p+(p.includes("?")?"&":"?")+"page="+n,n),list=this.cards(b),v={list,hasNextPage:list.length>0&&[...b.matchAll(/[?&](?:amp;)?page=(\d+)/g)].some(m=>+m[1]>n)};if(list.length){c.set(k,{t:Date.now(),v});if(c.size>20)c.delete(c.keys().next().value)}return v}
get supportsLatest(){return true}
getPopular(n){const i=Number(this.pref("popular","-1"));return this.listing(HH_CATS[i]?.[1]||"/popular",n)}
getLatestUpdates(n){const i=Number(this.pref("latest","-1"));return this.listing(HH_CATS[i]?.[1]||"/tv/all",n)}
async search(q,n,f){q=String(q||"").trim();const m=/^(?:https?:\/\/)?([a-z]{2}\.hoohootv\d+\.xyz)(\/[^#]*)?$/i.exec(q);if(m){if(!await this.adopt("https://"+m[1]))throw Error("새 주소에서 작품 목록을 확인하지 못했습니다.");this.save("domain","https://"+m[1]);if((m[2]||"").startsWith("/detail/")){if(n>1)return {list:[],hasNextPage:false};const d=await this.getDetail(m[2]);return {list:[{name:d.name,link:d.link,imageUrl:d.imageUrl}],hasNextPage:false}}return this.getPopular(n)}if(q)return this.listing("/search?sfl=common_title%7C%7Cseason_title%7C%7Ctag_title&sop=and&query="+encodeURIComponent(q),n);const state=t=>Number((f||[]).find(x=>x.type===t)?.state)||0,i=Math.max(0,Math.min(state("category"),HH_CATS.length-1)),r=state("rule");if(r===1)this.save("popular",i);if(r===2)this.save("latest",i);if(r===3||r===5)this.save("popular",-1);if(r===4||r===5)this.save("latest",-1);return this.listing(HH_CATS[i][1],n)}
async getDetail(u){const p=detail(u),h=await this.html(p),d=new Document(h),name=(attr(first(d,"meta[property='og:title']"),"content")||text(first(d,".share-title h1"))).replace(/\s*-\s*후후티비\s*$/,"").trim(),a=episodes(h);if(!name||!a.length)throw Error("작품 또는 회차 정보를 읽지 못했습니다.");const movie=a.length===1&&Number(a[0].episode)===0&&!a[0].date,multi=new Set(a.map(e=>e.season)).size>1,list=a.map((e,i)=>({name:movie?"1. 본편":i+1+". "+e.label,url:p+"?season="+e.season+"&episode="+encodeURIComponent(e.episode),dateUpload:e.date,scanlator:multi?"시즌"+e.season:""})).reverse(),latest=Math.max(0,...a.map(e=>Number(e.date)||0));return {name,link:p,imageUrl:absolute(this.getBaseUrl()+"/",attr(first(d,"meta[property='og:image']"),"content")),description:text(first(d,".overview")),genre:d.select(".share-title .datetime-hit a").map(text).filter(Boolean),status:movie?1:latest?(Date.now()-latest<21*86400000?0:1):5,episodes:list,chapters:list}}
async castVideo(t, e, r) {
    if ("function" != typeof createHlsProxyUrl)
      throw new Error(
        "후후티비 재생에는 HLS 프록시를 지원하는 최신 Mangayomi가 필요합니다. 앱을 업데이트해 주세요.",
      );
    let s;
    try {
      s = JSON.parse(
        /window\.TVP_CONFIG\s*=\s*(\{[^\n]*?\})\s*;/.exec(t)?.[1] || "",
      );
    } catch (t) {
      throw new Error("플레이어 설정을 읽지 못했습니다.");
    }
    if (
      !s.id ||
      "e" !== s.pathType ||
      !/^every[1-9]\.poorcdn\.com$/.test(s.host || "") ||
      !/^[a-f0-9]{32}$/.test(s.contentId || "")
    )
      throw new Error("지원하지 않는 후후티비 재생 설정입니다.");
    const i = e.replace(/^(https?:\/\/[^/]+).*/, "$1"),
      a = {
        "User-Agent": HH_UA,
        Referer: i + "/",
        Origin: i,
        Accept: "*/*",
      },
      n = async (t, e, r = {}) => {
        const s = await this.client.post(
          t,
          { ...a, "Content-Type": "application/json", ...r },
          e,
        );
        if (200 !== s.statusCode)
          throw new Error(`재생권 요청에 실패했습니다 (HTTP ${s.statusCode}).`);
        try {
          return JSON.parse(s.body);
        } catch (t) {
          throw new Error("재생권 응답을 읽지 못했습니다.");
        }
      },
      o = await n(
        i + "/player/api/cast.php",
        { id: String(s.id) },
        { "X-Player-Cast": "1" },
      ),
      c = "https://" + s.host;
    if (
      1 !== o?.version ||
      String(o.server) !== String(s.server) ||
      o.contentId !== s.contentId ||
      o.origin !== c ||
      o.registerUrl !== c + "/v/cast-register" ||
      "string" != typeof o.grant ||
      !o.grant.startsWith("r1.") ||
      o.grant.length > 384
    )
      throw new Error("올바른 재생권이 아닙니다.");
    const l = await n(o.registerUrl, { cast_grant: o.grant });
    if (
      !0 !== l?.ok ||
      l.contentId !== s.contentId ||
      "string" != typeof l.token ||
      !/^p1\.[A-Za-z0-9_.-]+$/.test(l.token) ||
      l.token.length > 384
    )
      throw new Error("재생권 등록에 실패했습니다.");
    const p = `${c}/v/e/${s.contentId}/c.html?cast=${encodeURIComponent(l.token)}`,
      h = await hhProxy(p, a);
    if ("string" != typeof h || !/^http:\/\/127\.0\.0\.1:\d+\//.test(h))
      throw new Error(
        "HLS 프록시를 시작하지 못했습니다. Mangayomi를 업데이트해 주세요.",
      );
    return [
      {
        url: h,
        originalUrl: p,
        quality: "자동 (HLS)",
        headers: a,
        subtitles: r,
      },
    ];
  }
safeUrl(u){return String(u||"").split(/[?#]/)[0].replace(/^(https?:\/\/)[^/@]+@/i,"$1").replace(/\/[A-Za-z0-9_.~-]{20,}/g,"/[id]").slice(0,140)}
safeError(e){return String(e?.message||e||"").replace(/https?:\/\/[^\s"'<>]+/gi,"[URL 생략]").replace(/\b(?:t|sig|token|grant|key|cast)=[^&\s]+/gi,"[인증값 생략]").replace(/\b[pr]1\.[A-Za-z0-9_.-]+/g,"[재생권 생략]").replace(/\s+/g," ").slice(0,180)}
responseKind(r){const b=String(r?.body||"").trim();if(b.startsWith("#EXTM3U"))return "HLS";if(/^<!doctype\s+html|^<html|<head\b|<body\b/i.test(b))return "HTML";if(/^[\[{]/.test(b))return "JSON";const h=r?.headers||{},raw=String(Object.entries(h).find(([k])=>k.toLowerCase()==="content-type")?.[1]||"").split(";")[0].trim();return /^[\w.+-]+\/[\w.+-]+$/.test(raw)?raw:"기타"}
isJw(u){return /^https:\/\/(?:[a-z0-9-]+\.)*jwpcdn\.net\/video\/embed\//i.test(String(u))}
mediaCandidates(body,page,doc){const out=[],seen=new Set(),add=(value,explicit=false)=>{const u=absolute(page,value),p=u.split(/[?#]/)[0];if(!/^https?:\/\//i.test(u)||/\.(?:js|css|png|jpe?g|webp|svg|vtt|srt)$/i.test(p)||(!explicit&&!/\.m3u8$/i.test(p))||seen.has(u))return;seen.add(u);out.push(u)};for(const n of doc.select("[data-m3u8]"))add(attr(n,"data-m3u8"),true);for(const n of doc.select("video[src],source[src]"))add(attr(n,"src"),/^application\/(?:x-mpegurl|vnd\.apple\.mpegurl)(?:;|$)/i.test(attr(n,"type")));const s=decode(body);for(const m of s.matchAll(/https?:\/\/[^"'\s<>\\]+\.m3u8(?:\?[^"'\s<>\\]*)?/gi))add(m[0]);if(this.isJw(page))for(const m of s.matchAll(/[?&]mu=([^&"'\s<>\\]+)/gi)){try{add(decodeURIComponent(m[1].replace(/\+/g," ")))}catch(_){}}return out.slice(0,4)}
async playbackSession(frame,page){let data;try{data=JSON.parse(decode(attr(frame,"data-session1")))}catch(_){throw Error("재생 세션 JSON 오류")}if(!data?.idx)throw Error("재생 세션 idx가 없습니다.");const o=origin(page),h={...this.getHeaders(page),Referer:page,Origin:o,"Content-Type":"application/json",Accept:"application/json"},r=await this.client.post(o+"/api/create_session.php",h,data);if(Number(r.statusCode)!==200)throw Error("재생 세션 HTTP "+r.statusCode);let s;try{s=JSON.parse(r.body)}catch(_){throw Error("재생 세션 응답 오류")}if(!s?.success||!/^https:\/\//.test(String(s.player_url||"")))throw Error("재생 세션 생성 실패");const url=String(s.player_url)+(s.player_url.includes("?")?"&":"?")+"t="+encodeURIComponent(s.t??"")+"&sig="+encodeURIComponent(s.sig??"");return {url,referer:page,subtitles:typeof data.vtt==="string"&&/^https?:\/\//.test(data.vtt)?[{file:data.vtt,label:"자막"}]:[]}}
async directVideo(url,page,subs,ua=HH_UA){const h={"User-Agent":ua,Referer:page,Origin:origin(page),Accept:"*/*"},r=await this.client.get(url,h),body=String(r.body||"").trim();if(Number(r.statusCode)!==200||!body.startsWith("#EXTM3U"))throw Error("HLS 확인 HTTP "+r.statusCode+" / 응답 "+this.responseKind(r));const out=[{url,originalUrl:url.replace(/#.*$/,"")+"#download.m3u8",quality:"자동 (HLS)",headers:h,subtitles:subs}],lines=body.split(/\r?\n/);for(let i=0;i<lines.length-1;i++){if(!lines[i].startsWith("#EXT-X-STREAM-INF:"))continue;const n=/RESOLUTION=\d+x(\d+)/.exec(lines[i])?.[1];let j=i+1;while(j<lines.length&&!lines[j].trim())j++;if(j<lines.length&&!lines[j].startsWith("#")){const u=absolute(url,lines[j].trim());if(u)out.push({url:u,originalUrl:u.replace(/#.*$/,"")+"#download.m3u8",quality:n?n+"p":"화질 "+j,headers:h,subtitles:subs})}}const want=this.pref("quality","자동");return want==="자동"?out:out.filter(x=>x.quality===want).concat(out.filter(x=>x.quality!==want))}
async observeJw(item){if(typeof evaluateJavascriptViaWebview!=="function")throw Error("앱 웹뷰 실행 기능 없음");const raw=await evaluateJavascriptViaWebview(item.url,{Referer:item.referer},["("+jwObserve.toString()+")();"],16);let r;try{r=typeof raw==="string"?JSON.parse(raw):raw;if(typeof r==="string")r=JSON.parse(r)}catch(_){throw Error("JW 웹뷰 응답 JSON 오류")}if(!r||!Array.isArray(r.urls))throw Error("JW 웹뷰 응답 없음");return r}
recordPage(r,record){for(const t of Array.isArray(r.timeline)?r.timeline.slice(-4):[])record("로딩이력",t.url,"ms "+Number(t.ms||0)+" / "+String(t.readyState||"미수신"));const p=r.page||{};for(const f of Array.isArray(p.frames)?p.frames.slice(0,3):[])record("프레임",f.url||f.src,"접근 "+String(f.access||"미수신")+" / 상태 "+String(f.readyState||"미수신")+" / src "+this.safeUrl(f.src));for(const e of Array.isArray(r.errors)?r.errors.slice(-2):[])record("JS오류","",e);record("관찰종료문서",p.url||"(주소 미수신)","상태 "+String(p.readyState||"미수신")+" / 제목 "+String(p.title||"없음")+" / top "+String(p.topLevel??"미수신")+" / scripts "+String(p.scriptCount??"미수신")+" / frames "+String(p.frameCount??"미수신"))}
async getVideoList(u){const p=detail(u),q=/\?([^#]*)/.exec(String(u))?.[1]||"",path=p+(q?"?"+q:""),page=this.getBaseUrl()+path,logs=[],record=(stage,url,message)=>{logs.push(stage+" "+this.safeUrl(url)+" · "+this.safeError(message));if(logs.length>16)logs.shift();this.save("playback_diag",logs.join("\n"))};this.save("playback_diag","");let body;try{body=await this.html(path)}catch(e){record("회차",page,e);throw this.playbackError(logs)}const queue=[{url:page,body,referer:this.getBaseUrl()+"/",subtitles:[]}],queued=new Set([page]),seen=new Set(),mediaSeen=new Set(),enqueue=x=>{if(queue.length<12&&!queued.has(x.url)){queued.add(x.url);queue.push(x)}};let observed=false;for(let i=0;i<queue.length&&i<6;i++){if(this.__deadline&&Date.now()>this.__deadline-5000){record("시간",page,"앱 제한 40초 앞 — 중단");break}const item=queue[i];if(seen.has(item.url))continue;seen.add(item.url);let b=item.body;try{if(b===undefined){const r=await this.client.get(item.url,{...this.getHeaders(item.referer),Referer:item.referer,Origin:origin(item.referer)});record("플레이어",item.url,"HTTP "+r.statusCode+" / 응답 "+this.responseKind(r));if(Number(r.statusCode)!==200)continue;b=String(r.body||"")}}catch(e){record("플레이어",item.url,e);continue}let doc;try{doc=new Document(b)}catch(e){record("문서",item.url,e);continue}for(const frame of doc.select("iframe").slice(0,6)){if(attr(frame,"data-session1")){try{enqueue(await this.playbackSession(frame,item.url))}catch(e){record("세션",item.url,e)}}const target=absolute(item.url,attr(frame,"data-src")||attr(frame,"src"));if(target)enqueue({url:target,referer:item.url,subtitles:item.subtitles})}if(this.isJw(item.url))for(const m of decode(b).matchAll(/https:\/\/(?:[a-z0-9-]+\.)*creatorofvideo\.com\/play\/[A-Za-z0-9_-]+(?:\?[^"'\s<>\\]*)?/gi))enqueue({url:m[0],referer:item.url,subtitles:item.subtitles});if(/window\.TVP_CONFIG\s*=/.test(b)){try{const v=await this.castVideo(b,item.url,item.subtitles);record("완료",item.url,"TVP 인계");return v}catch(e){record("TVP",item.url,e)}}try{const sv=await this.streamVideo(b,item.url);if(sv){record("완료",item.url,"stream/m3u8 키 방식");return sv}}catch(e){record("stream",item.url,e)}const candidates=this.mediaCandidates(b,item.url,doc);for(const m of candidates){if(mediaSeen.has(m))continue;mediaSeen.add(m);try{const v=await this.directVideo(m,item.url,item.subtitles);record("완료",m,"HLS 확인");return v}catch(e){record("HLS 후보",m,e)}}if(this.isJw(item.url)&&!observed&&!this.__noJw){observed=true;try{const r=await this.observeJw(item);record("웹뷰요청",item.url,"관찰 진입");this.recordPage(r,record);record("JW 관찰",item.url,"JW "+(r.jw?"있음":"없음")+" / video "+Number(r.videoCount||0)+" / 후보 "+r.urls.length);const subs=Array.isArray(r.subtitles)?r.subtitles.filter(x=>x&&/^https?:\/\//.test(String(x.file||""))).slice(0,8):item.subtitles;for(const x of r.urls.slice(0,4)){const m=absolute(item.url,x?.url),p=m.split(/[?#]/)[0];if(!/^https?:\/\//.test(m)||(!/\.m3u8$/i.test(p)&&!x?.explicit)||/\.(?:js|css|png|vtt|srt)$/i.test(p))continue;try{const v=await this.directVideo(m,item.url,subs,typeof r.ua==="string"&&r.ua?r.ua:HH_UA);record("완료",m,"JW 영상 확인");return v}catch(e){record("JW HLS",m,e)}}for(const target of Array.isArray(r.children)?r.children.slice(0,4):[])if(/^https:\/\/(?:[a-z0-9-]+\.)*(?:jwpcdn\.net|creatorofvideo\.com)\//i.test(target))enqueue({url:target,referer:item.url,subtitles:subs})}catch(e){record("JW 관찰",item.url,e)}}if(!candidates.length)record("탐색",item.url,"TVP "+(/window\.TVP_CONFIG\s*=/.test(b)?"있음":"없음")+" / 후보 0 / iframe "+doc.select("iframe").length)}throw this.playbackError(logs)}
getFilterList(){const diag=this.pref("playback_diag");return [{type_name:"HeaderFilter",name:"[시험] 후후티비 0.0.21 · 재생 실패 시 웹뷰 보강 재시도 + 진단 표시"},...diag.split("\n").filter(Boolean).map(name=>({type_name:"HeaderFilter",name})),{type_name:"SelectFilter",type:"category",name:"분류",state:0,values:HH_CATS.map(([name,value])=>({type_name:"SelectOption",name,value}))},{type_name:"SelectFilter",type:"rule",name:"인기/최신 탭 규칙",state:0,values:["저장하지 않음","인기 탭에 저장","최신 탭에 저장","인기 기본값 복원","최신 기본값 복원","모두 복원"].map((name,i)=>({type_name:"SelectOption",name,value:String(i)}))},...Array.from({length:3},()=>({type_name:"HeaderFilter",name:" "}))]}
getSourcePreferences(){return [{key:"hh_test_domain",editTextPreference:{title:"후후티비 주소",summary:"비워 두면 기본 주소 사용. 직접 지정한 주소가 우선입니다.",value:"",dialogTitle:"사이트 주소",dialogMessage:"예: https://fl.hoohootv464.xyz"}},{key:"hh_test_auto",listPreference:{title:"주소 안내 확인",summary:"접속 실패 시 공개 안내 글을 확인합니다.",valueIndex:0,entries:["켬","끔"],entryValues:["true","false"]}},{key:"hh_test_stage",listPreference:{title:"재생 단계 시험(진단)",summary:"평소엔 0. 1·2·3 은 단계까지만 하고 결과를 오류로 보여 줌",valueIndex:0,entries:["0 정상","1 진입 확인","2 회차 화면까지","3 플레이어 요청까지"],entryValues:["0","1","2","3"]}},{key:"hh_test_quality",listPreference:{title:"선호 화질",summary:"직접 HLS에만 적용. TVP 캐스트는 앱의 자동 화질을 사용합니다.",valueIndex:0,entries:["자동","1080p","720p","480p","360p"],entryValues:["자동","1080p","720p","480p","360p"]}}]}
}
DefaultExtension.prototype.playbackError=function(logs){const rows=Array.isArray(logs)?logs:[],frames=rows.filter(x=>String(x).startsWith("프레임 ")),last=prefix=>rows.filter(x=>String(x).startsWith(prefix)).slice(-1)[0]||"",tail=row=>String(row).split(" · ").slice(1).join(" · "),frame=row=>{const i=row.indexOf(" · "),actual=row.slice(4,i<0?undefined:i).trim(),info=i<0?"접근·상태 미수신":row.slice(i+3),m=/ \/ src (.*)$/.exec(info),src=m?.[1]||actual;return "프레임: "+(src||"주소 미수신")+"\n"+info.replace(/ \/ src .*$/,"")+(actual&&actual!==src?"\n실제: "+actual:"")},lines=[];if(frames.length)lines.push(frame(frames[0]));else lines.push("프레임 세부정보 미수신");const jw=tail(last("JW 관찰 "));if(jw)lines.push(jw);const doc=last("관찰종료문서 ");if(doc){const state=/상태 ([^/]+)/.exec(tail(doc))?.[1]?.trim();if(state)lines.push("문서 상태: "+state)}for(const row of frames.slice(1))lines.push(frame(row));const js=tail(last("JS오류 "));if(js)lines.push("JS: "+js);if(!frames.length){const detail=last("JW 관찰 ")||last("회차 ")||last("플레이어 ")||rows.slice(-1)[0];if(detail&&!lines.includes(detail))lines.push(String(detail));if(doc)lines.push(doc)}return new Error("[후후티비 0.0.21] 재생 실패\n"+lines.join("\n"))};

// ---------- 0.0.7 웹뷰 보강 재생 (야툰 영상에서 휴대폰 재생에 성공한 방식) ----------
// 기존 방식(재생 세션·TVP·JW 관찰)이 모두 실패했을 때만 실행: 플레이어 화면을 웹뷰로 열어 불러온 m3u8/mp4 를 모으고,
// m3u8 길이를 재서 가장 긴 것을 본편으로 고름(광고·맛보기 거름). 실패하면 원래 오류 뒤에 웹뷰 진단을 붙임.
const HH_WEBVIEW = false;
(function () {
    const UA2 = HH_UA;
    const mk = (self) => ({ capture: async (url, referer) => {
        if (typeof evaluateJavascriptViaWebview !== "function") return null;
        const script = "(function(){var n=0;function found(){var r=performance.getEntriesByType('resource'),o=[];" +
            "for(var i=0;i<r.length;i++){var u=r[i].name;if((/\\.(m3u8|mp4|m4v|webm)(\\?|$)|\\/(hls|playlist|manifest|master)[^\\/]*$/.test(u)||r[i].initiatorType==='video')&&!/_preview\\.mp4/.test(u)&&o.indexOf(u)<0)o.push(u);}" +
            "var v=document.querySelector('video');var s=v&&(v.currentSrc||v.src);if(s&&/^https?:/.test(s)&&o.indexOf(s)<0)o.push(s);return o;}" +
            "var t=setInterval(function(){n++;var o=found();var v0=document.querySelector('video');var du=v0?v0.duration:0;if((o.length&&n>=2&&du>=120)||(o.length&&n>=40&&!(du>0))||(o.length&&n>=76)||n>=80){clearInterval(t);" +
            "if(!o.length){var h=document.documentElement.outerHTML.replace(/\\\\\\//g,'/').match(/https?:[^\"'\\s<>\\\\]+?\\.(m3u8|mp4)[^\"'\\s<>\\\\]*/g)||[];for(var k=0;k<h.length;k++)if(!/_preview\\.mp4/.test(h[k])&&o.indexOf(h[k])<0)o.push(h[k]);}" +
            "window.flutter_inappwebview.callHandler('setResponse',JSON.stringify({list:o,href:location.href,title:document.title,len:document.documentElement.outerHTML.length,ifr:document.querySelectorAll('iframe').length,vid:document.querySelectorAll('video').length,vs:String((document.querySelector('video')||{}).currentSrc||(document.querySelector('video')||{}).src||'').substring(0,120),rs:performance.getEntriesByType('resource').map(function(x){return x.initiatorType+':'+x.name}).filter(function(x){return !/\\.(css|js|png|jpe?g|gif|svg|woff2?|ico)(\\?|$)/.test(x)}).slice(-6)}));return;}" +
            "if(n===2||n===6||n===12||n===20||n===40||n===80){var v=document.querySelector('video');if(v){v.muted=true;try{v.play();}catch(e){}}" +
            "var b=document.querySelector('.vjs-big-play-button,.plyr__control--overlaid,.jw-icon-display,.art-state,[class*=play]');if(b)b.click();}},250);})();";
        const timeout = new Promise((r) => setTimeout(() => r(null), Math.max(6000, Math.min(24000, (self.__deadline || 0) - Date.now()))));
        try {
            const res = await Promise.race([evaluateJavascriptViaWebview(url, { "Referer": referer, "User-Agent": UA2 }, [script], 18), timeout]);
            return res ? (typeof res === "string" ? JSON.parse(res) : res) : null;
        } catch (e) { return null; }
    } });
    const dur = async (self, u, h, depth) => {
        try {
            const r = await self.client.get(u, h);
            if (Number(r.statusCode) >= 400) return -1;
            const t = String(r.body || "");
            if (/#EXT-X-STREAM-INF/.test(t) && !depth) {
                const m = /#EXT-X-STREAM-INF[^\n]*\n([^\n#][^\n]*)/.exec(t);
                return m ? dur(self, new URL(m[1].trim(), u).href, h, 1) : -1;
            }
            let sum = 0, re = /#EXTINF:([\d.]+)/g, x;
            while ((x = re.exec(t))) sum += parseFloat(x[1]);
            return sum > 0 ? sum : -1;
        } catch (e) { return -1; }
    };
    DefaultExtension.prototype.webFallback = async function (u) {
        const p = detail(u), q = /\?([^#]*)/.exec(String(u))?.[1] || "", path = p + (q ? "?" + q : "");
        const page = this.getBaseUrl() + path;
        const doc = new Document(await this.html(path));
        const targets = [];
        const add = (url, ref) => { if (url && !targets.some((t) => t.url === url)) targets.push({ url, ref }); };
        for (const f of doc.select("iframe").slice(0, 4)) {
            if (attr(f, "data-session1")) { try { const s = await this.playbackSession(f, page); add(s.url, page); } catch (e) { /* 다음 */ } }
            add(absolute(page, attr(f, "data-src") || attr(f, "src")), page);
        }
        add(page, this.getBaseUrl() + "/");
        const tool = mk(this);
        const diag = [];
        for (const t of targets.slice(0, 2)) {
            if (this.__deadline - Date.now() < 6000) { diag.push("시간 부족(앱 제한 40초)"); break; }
            const info = await tool.capture(t.url, t.ref);
            const list = ((info && info.list) || []).filter((x) => /^https?:\/\//.test(x));
            const host = (/^https?:\/\/([^/]+)/.exec(t.url) || [])[1] || "?";
            if (!list.length) { diag.push(info ? `${host}: 제목="${String(info.title || "").substring(0, 20)}" iframe=${info.ifr} video=${info.vid} src=${info.vs || "없음"}` : `${host}: 웹뷰 응답 없음`); continue; }
            const o = origin(t.url);
            const h = { "User-Agent": UA2, "Referer": o + "/", "Origin": o, "Accept": "*/*" };
            const rows = [];
            for (const x of list.slice(0, 3)) rows.push({ x, sec: /m3u8/i.test(x) ? await dur(this, x, h, 0) : -1 });
            rows.sort((a, b) => b.sec - a.sec);
            const fmt = (s) => s > 0 ? ` ${Math.floor(s / 60)}분${Math.round(s % 60)}초` : "";
            return rows.map((r, i) => ({ url: r.x, originalUrl: /m3u8/i.test(r.x) ? r.x.replace(/#.*$/, "") + "#download.m3u8" : r.x,
                quality: `웹뷰${/m3u8/i.test(r.x) ? " HLS" : " MP4"}${fmt(r.sec)}${r.sec > 0 && r.sec < 60 ? " (광고?)" : ""}${i ? " #" + (i + 1) : ""}`, headers: h, subtitles: [] }));
        }
        this.__fbWhy = diag.join(" | ") || "후보 없음";
        return null;
    };
    // 티비룸 방식: 플레이어 HTML 의 /stream/m3u8/ 주소 + 암호 키(X-Hls-Key) 복원 + HLS 프록시
    DefaultExtension.prototype.streamVideo = async function (body, pageUrl) {
        const c = /https?:\/\/[^"'\s<>\\]+\/stream\/m3u8\/[^"'\s<>\\]+/.exec(String(body).replace(/\\\//g, "/"))?.[0];
        if (!c) return null;
        const n = pageUrl.replace(/^(https?:\/\/[^/]+).*/, "$1");
        const a = { "User-Agent": UA2, Referer: n + "/", Origin: n, Accept: "*/*" };
        const l = await this.client.get(c, a);
        if (Number(l.statusCode) !== 200 || !/^#EXTM3U/.test(String(l.body).trim())) throw new Error("stream 재생목록 HTTP " + l.statusCode);
        const h = { ...a };
        const ku = /#EXT-X-KEY:[^\n]*URI="(https?:\/\/[^"]+)"/.exec(l.body)?.[1];
        if (ku) {
            const k = await this.client.get(ku, a);
            if (Number(k.statusCode) !== 200) throw new Error("stream 키 HTTP " + k.statusCode);
            h["X-Hls-Key"] = hhUnscramble(k.body);
        }
        if (typeof createHlsProxyUrl !== "function") return [{ url: c, originalUrl: c.replace(/#.*$/, "") + "#download.m3u8", quality: "자동 (HLS)", headers: a, subtitles: [] }];
        const g = await hhProxy(c, h);
        if (typeof g !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\//.test(g)) throw new Error("HLS 프록시 시작 실패");
        return [{ url: g, originalUrl: c, quality: "자동 (HLS)", headers: a, subtitles: [] }];
    };
    // 같은 재생 세션을 두 번 만들지 않게(두 경로가 동시에 같은 세션을 씀) 한 번만 만들어 공유
    const ps = DefaultExtension.prototype.playbackSession;
    DefaultExtension.prototype.playbackSession = function (frame, page) {
        const key = attr(frame, "data-session1") + "|" + page;
        const m = this.__sess || (this.__sess = new Map());
        if (!m.has(key)) m.set(key, ps.call(this, frame, page));
        return m.get(key);
    };
    const base = DefaultExtension.prototype.getVideoList;
    // 앱 제한 40초 안에 끝내기: 기존 방식(세션·TVP·stream·JW 정적 분석)과 웹뷰 수집을 동시에 시작, 먼저 성공한 것을 사용
    // 단계 시험(설정 > 재생 단계): 어디서 멈추는지 가르기 위해 일부 단계까지만 하고 결과를 오류로 보여 줌
    const stageRun = async (self, u, stage) => {
        const t0 = Date.now(), sec = () => Math.round((Date.now() - t0) / 100) / 10 + "초";
        const out = ["[후후티비 0.0.21] 단계 " + stage + " 시험"];
        if (stage === "1") { out.push("재생 함수 진입 확인됨"); return hhDiag(out); }
        const p = detail(u), q = /\?([^#]*)/.exec(String(u))?.[1] || "", path = p + (q ? "?" + q : "");
        const page = self.getBaseUrl() + path;
        out.push("주소 " + self.getBaseUrl());
        let body = "";
        try { body = String(await self.html(path)); out.push("회차 화면 " + body.length + "자 (" + sec() + ")"); }
        catch (e) { out.push("회차 화면 실패: " + String((e && e.message) || e).substring(0, 80) + " (" + sec() + ")"); return hhDiag(out); }
        const frames = body.match(/<iframe[^>]*>/gi) || [];
        out.push("iframe " + frames.length + "개");
        frames.slice(0, 3).forEach((f) => out.push("  " + f.replace(/\s+/g, " ").substring(0, 150)));
        out.push("data-session1 " + (/data-session1/.test(body) ? "있음" : "없음") + " / TVP " + (/TVP_CONFIG/.test(body) ? "있음" : "없음") + " / m3u8 글자 " + (body.match(/\.m3u8/g) || []).length);
        if (stage === "2") return hhDiag(out);
        const m = /<iframe[^>]*?(?:data-src|src)=["']([^"']+)["']/i.exec(body);
        const target = m ? absolute(page, m[1]) : "";
        if (!target) { out.push("플레이어 주소 없음"); return hhDiag(out); }
        out.push("플레이어 " + target.replace(/^https?:\/\//, "").substring(0, 70));
        try {
            const r = await self.client.get(target, { "User-Agent": HH_UA, Referer: page, Accept: "text/html,*/*" });
            const b = String(r.body || "");
            out.push("플레이어 응답 HTTP " + r.statusCode + " " + b.length + "자 (" + sec() + ")");
            const hits = (b.replace(/\\\//g, "/").match(/https?:\/\/[^"'\s<>\\]*(?:m3u8|creatorofvideo|\/play\/|\/hls\/|\/stream\/)[^"'\s<>\\]*/g) || []);
            hits.slice(0, 4).forEach((h) => out.push("  주소 " + h.replace(/token=[^&]*/, "token=…").substring(0, 120)));
            out.push("jwplayer " + (/jwplayer/i.test(b) ? "있음" : "없음") + " / setup " + (/\.setup\(/.test(b) ? "있음" : "없음") + " / 앞부분 " + b.replace(/\s+/g, " ").substring(0, 160));
        } catch (e) { out.push("플레이어 요청 실패: " + String((e && e.message) || e).substring(0, 80) + " (" + sec() + ")"); }
        return hhDiag(out);
    };
    DefaultExtension.prototype.getVideoList = function (u) {
        const args = arguments, self = this, t0 = Date.now();
        const stg = String(this.pref("stage", "0")).charAt(0);
        if (stg !== "0") return stageRun(this, u, stg);
        // 멈춤 위치 기록: 단계마다 직전에 적어 두고, 40초 초과로 끊기면 다음 시도(재시도)에서 마지막 단계를 바로 보여 줌
        const prev = String(self.pref("trail", "") || "");
        if (prev && !prev.includes("종료")) {
            self.save("trail", "");
            return Promise.reject(new Error("[후후티비 0.0.21] 직전 시도가 멈춘 곳(마지막 줄이 응답 없던 단계):\n" + prev.split("|").slice(-8).join("\n") + "\n※ 다시 눌러야 새로 시도합니다"));
        }
        let trail = [];
        const mark = (m) => { trail.push(Math.round((Date.now() - t0) / 100) / 10 + "초 " + m); self.save("trail", trail.slice(-14).join("|")); };
        globalThis.__hhMark = mark;
        mark("시작 " + String(u).substring(0, 60));
        const c0 = self.client;
        if (!c0.__w) {
            c0.__w = true;
            for (const k of ["get", "post"]) {
                if (typeof c0[k] !== "function") continue;
                const f = c0[k].bind(c0);
                c0[k] = async function (url) {
                    mark(k + " 요청 " + String(url).replace(/^https?:\/\//, "").substring(0, 70));
                    try { const r = await f.apply(null, arguments); mark("응답 " + r.statusCode + " " + String((r.body || "").length) + "자"); return r; }
                    catch (e) { mark("오류 " + String((e && e.message) || e).substring(0, 50)); throw e; }
                };
            }
        }
        
        self.__noJw = false; self.__sess = new Map(); self.__deadline = t0 + 30000;
        return new Promise((resolve, reject) => {
            let bErr = null, fErr = null, bDone = false, fDone = false, fVal = null, fin = false, grace = null;
            const ok = (v) => { if (fin) return; mark("종료 성공"); fin = true; clearTimeout(tm); clearTimeout(grace); resolve(v); };
            const bad = () => {
                if (fin) return; mark("종료 실패"); fin = true; clearTimeout(tm); clearTimeout(grace);
                reject(new Error(String((bErr && bErr.message) || bErr || "기존 방식 응답 없음") + "\n[웹뷰 보강] " + (fErr || self.__fbWhy || "응답 없음") + " (" + Math.round((Date.now() - t0) / 1000) + "초)"));
            };
            const tm = setTimeout(bad, 37000);
            let bp;
            try { bp = base.apply(self, args); } catch (e) { bp = Promise.reject(e); }
            bp.then((v) => { bDone = true; ok(v); }, (e) => { bDone = true; bErr = e; if (fDone) { fVal ? ok(fVal) : bad(); } });
            (HH_WEBVIEW ? self.webFallback(u) : (self.__fbWhy = "웹뷰 끔(0.0.12 구분 시험)", Promise.resolve(null))).then((v) => {
                fDone = true;
                if (v && v.length) { fVal = v; if (bDone) ok(v); else grace = setTimeout(() => ok(v), 2500); }
                else if (bDone) bad();
            }, (e) => { fDone = true; fErr = String((e && e.message) || e).substring(0, 100); if (bDone) bad(); });
        });
    };
})();

// ---------- 검색 띄어쓰기 (2026-11-05) ----------
// 사이트 검색이 띄어쓰기를 구분해 "괴력난신"·"나혼자만레벨업" 으로는 "괴력 난신"·"나 혼자만 레벨업" 이 안 나오는 곳이 있음.
// 결과가 0개일 때만: ① 띄어쓰기를 뺀 검색어 ② 검색어 앞부분(절반) ③ 두 글자씩(앞에서부터) 으로 최대 6번 다시 찾아,
// 띄어쓰기·기호를 빼고 비교했을 때 검색어가 들어 있는 작품만 보여 줌. 결과가 있으면 원래 그대로
(function () {
    const base = DefaultExtension.prototype.search;
    DefaultExtension.prototype.search = async function (query, page, filters) {
        const r = await base.apply(this, arguments);
        const q = String(query || "").trim();
        if (!q || Number(page) > 1 || /^(?:https?:\/\/|[\w-]+(?:\.[\w-]+)+(?:[/?#]|$))/i.test(q) || (r && r.list && r.list.length)) return r;
        const squash = (s) => String(s || "").normalize("NFC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
        const want = squash(q);
        if (want.length < 2) return r;
        const joined = q.replace(/\s+/g, "");
        const tries = [];
        const add = (t) => { if (t && t.length >= 2 && t !== q && tries.indexOf(t) < 0) tries.push(t); };
        // 사이트 검색은 쉼표·쌍점·물결·괄호·한자 같은 기호가 있으면 못 찾음("밑도 끝도 없이, 너다" 0개, 2026-11-06 검색 검사)
        // → 기호를 뺀 검색어, 앞쪽 단어만으로 먼저 찾아 봄
        const plain = q.replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/[\u3400-\u9fff]+/g, " ").replace(/\s+/g, " ").trim();
        const words = plain.split(" ").filter((w) => w);
        add(plain);
        if (words.length > 2) add(words.slice(0, words.length - 1).join(" "));
        if (words.length > 1) add(words.slice(0, Math.ceil(words.length / 2)).join(" "));
        add(joined);
        if (joined.length > 2) add(joined.substring(0, Math.max(2, Math.ceil(joined.length / 2))));
        for (let i = 0; i + 2 <= joined.length; i++) add(joined.substring(i, i + 2));
        for (const t of tries.slice(0, 8)) {
            try {
                const r2 = await base.call(this, t, 1, filters);
                const hit = ((r2 && r2.list) || []).filter((x) => squash(x && x.name).includes(want));
                if (hit.length) return { list: hit, hasNextPage: false };
            } catch (e) {
                // 다음 방법으로
            }
        }
        return r;
    };
})();

// ---------- 영화 회차 이름 통일 (2026-11-06, 사용자 "통일시켜") ----------
// 확장마다 영화 회차가 "바로보기"·"한글자막"·"1회 · 바로보기"·"애니감상"·"1. 극장판 X" 처럼 달라서 → "본편" 으로.
// 회차가 하나뿐이고 회차 번호(N화·N회·EN)가 없을 때만 (자막·더빙 같은 구분은 괄호로), 상태를 모르면 완결
(function () {
    const base = DefaultExtension.prototype.getDetail;
    const core = (n) => String(n || "").replace(/^\s*\d+\s*(?:회)?\s*[.·]\s*/, "").replace(/\s*\(\d{2}\.\d{2}\)\s*$/, "").trim();
    const hasNo = (n) => /\d+\s*(?:화|회)|(?:^|\s)E\d+/i.test(core(n));
    const movieName = (n) => {
        const v = (core(n).match(/한글\s*자막|영어\s*자막|자막|더빙|무삭제|감독판|확장판|극장판/g) || [])
            .map((x) => x.replace(/\s+/g, "")).filter((x) => x !== "극장판");
        return v.length ? `본편 (${[...new Set(v)].join(" · ")})` : "본편";
    };
    DefaultExtension.prototype.getDetail = async function (url) {
        const d = await base.apply(this, arguments);
        const eps = (d && d.episodes) || [];
        const variant = /바로\s*보기|본편|자막|더빙|애니감상/;
        const movie = eps.length === 1 ? !hasNo(eps[0].name)
            : eps.length > 1 && eps.every((e) => !hasNo(e.name) && variant.test(core(e.name)));
        if (!movie) return d;
        // 망가요미는 이름 맨 앞 숫자로 회차 번호를 매김 → 숫자가 없으면 "번호를 매길 수 없음" 경고가 떠서 "1. 본편" (사용자, 2026-11-06)
        eps.forEach((e, i) => { e.name = `${i + 1}. ${movieName(e.name)}`; });
        if (d.status === 5 || d.status === undefined) d.status = 1;
        return d;
    };
})();

// ---------- 회차 번호 겹침 막기 (2026-11-07 회차 점검) ----------
// 망가요미는 회차 이름에서 숫자를 읽어 번호를 매기고(lib/utils/chapter_recognition.dart: 작품 제목을 지운 뒤 첫 숫자,
// "season/s/t N"·"ep N" 따로), 번호가 같은 회차는 하나만 남김 → "프롤로그 · 남은 98화"(98)와 "98화"가 겹치거나
// "키스 대신 7초 34화"가 모두 7 이 되어 회차가 사라짐. 같은 방식으로 미리 읽어 보고, 겹치거나 번호가 없는 작품만
// 오래된 회차부터 겹치지 않는 번호를 이름 앞에 붙임("35. …", 겹치면 "39.01. …"). 문제없는 작품은 그대로
(function () {
    const base = DefaultExtension.prototype.getDetail;
    const unwanted = /\b(?:v|ver|vol|version|volume|season|staffel|saison|temporada|s|t)[^a-z]?[0-9]+/g;
    const seasonKw = /\b(?:staffel|season|saison|temporada|s|t)\s*([0-9]+)/;
    const epKw = /\b(?:folge|episode|episodio|ep\.?)\s*([0-9]+(?:\.[0-9]+)?)/;
    const chNot = /(?<=ch\.) *([0-9]+)(\.[0-9]+)?(\.?[a-z]+)?/;
    const bare = /([0-9]+)(\.[0-9]+)?(\.?[a-z]+)?/;
    const dec = (d, a) => {
        if (d) return parseFloat(d);
        if (a) {
            if (a.includes("extra")) return 0.99;
            if (a.includes("omake")) return 0.98;
            if (a.includes("special")) return 0.97;
            const t = a.replace(".", "");
            if (t.length === 1) { const k = t.charCodeAt(0) - 96; return k >= 10 ? 0 : k / 10; }
        }
        return 0;
    };
    const read = (title, ch) => {
        let n = String(ch || "").toLowerCase();
        if (title) n = n.split(String(title).toLowerCase()).join("");
        n = n.trim().replace(/,/g, ".").replace(/-/g, ".").replace(/\s(?=extra|special|omake)/g, "");
        const sm = seasonKw.exec(n);
        const season = sm ? sm[1] : "0";
        const em = epKw.exec(n);
        if (em) return { season, ep: parseFloat(em[1]) };
        const s2 = n.replace(unwanted, "");
        const m = chNot.exec(s2) || bare.exec(s2);
        return { season, ep: m ? parseFloat(m[1]) + dec(m[2], m[3]) : null };
    };
    const ok = (list, title) => {
        const seen = {};
        for (const x of list) {
            const r = read(title, x.name);
            if (r.ep === null || !(r.ep > 0)) return false;
            const k = `${r.season}::${r.ep}::${x.scanlator || ""}`;
            if (seen[k]) return false;
            seen[k] = true;
        }
        return true;
    };
    // 붙일 번호 짐작: "34화"·"5회" 를 먼저, 없으면 앱 방식. 확장이 붙인 " · 남은 N화"·" · 마지막"·끝 날짜 "(11.05)" 는 빼고 읽음
    const guessNo = (title, name) => {
        const core = String(name || "").replace(/\s*·\s*(?:남은\s*\d+\s*화|마지막)\s*$/, "").replace(/\s*\(\d{2}(?:\.\d{2}){1,2}\)\s*$/, "");
        const m = /(\d+(?:[.-]\d+)?)\s*(?:화|회|話)/.exec(core);
        if (m) return parseFloat(m[1].replace("-", "."));
        return read(title, core).ep;
    };
    DefaultExtension.prototype.getDetail = async function (url) {
        const d = await base.apply(this, arguments);
        const list = d && (d.episodes || d.chapters);
        if (!list || !list.length) return d;
        const title = String(d.name || "");
        // 앱이 기억한 제목이 조금 달라 지워지지 않는 경우까지 보려고 제목을 지운 것·안 지운 것 둘 다 확인
        if (ok(list, title) && ok(list, "")) return d;
        let last = 0;
        const fmt = (v) => String(Math.round(v * 100) / 100);
        for (let i = list.length - 1; i >= 0; i--) { // 목록은 최신이 위 → 오래된 것부터
            const x = list[i];
            const plain = String(x.name || "").replace(/^\s*\d+(?:\.\d+)?\.\s+/, "");
            const guess = guessNo(title, plain);
            const v = guess !== null && guess > last ? guess : Math.round((last + 0.01) * 100) / 100;
            last = v;
            const lead = /^\s*(\d+(?:\.\d+)?)/.exec(plain);
            x.name = lead && parseFloat(lead[1]) === v && !/^\s*\d+(?:\.\d+)?\s*[-.,]\s*\d/.test(plain) ? plain : `${fmt(v)}. ${plain}`;
        }
        return d;
    };
})();


// ---------- 티비룸 키 복원 도우미 ----------
function hhBytesOf(t) { const e = []; for (let r = 0; r < t.length; r++) e.push(255 & t.charCodeAt(r)); return e; }
function hhHex(t) { return t.map((x) => x.toString(16).padStart(2, "0")).join(""); }
function hhB64(t) {
    const e = String(t).replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, ""), r = [];
    let s = 0, i = 0;
    for (const ch of e) { i = (i << 6) | "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(ch); s += 6; if (s >= 8) { s -= 8; r.push((i >> s) & 255); } }
    return r;
}
function hhUnscramble(t) {
    const e = String(t || "");
    if (16 === e.length && !/^[A-Za-z0-9+/=\s]+$/.test(e)) return hhHex(hhBytesOf(e));
    let r; try { r = JSON.parse(String.fromCharCode(...hhB64(e))); } catch (x) { r = null; }
    const s = r?.rule, i = s?.segment_sizes, n = s?.permutation, a = Number(s?.noise_length || 0);
    if (!Array.isArray(i) || !Array.isArray(n) || n.length !== i.length || [...n].sort((x, y) => x - y).some((x, y) => x !== y)) throw new Error("지원하지 않는 재생 키 형식");
    const o = hhB64(String(r.encrypted_key || "")), c = new Array(n.length);
    let l = 0;
    i.forEach((x, y) => { c[n[y]] = o.slice(l, l + x); l += x + a; });
    const h = c.flat();
    if (h.length !== (Number(s.key_length) || 16) || l > o.length) throw new Error("재생 키 복원 실패");
    return hhHex(h);
}

async function hhProxy(u, h) {
    if (globalThis.__hhMark) globalThis.__hhMark("HLS 프록시 생성 요청");
    const r = await createHlsProxyUrl(u, h);
    if (globalThis.__hhMark) globalThis.__hhMark("HLS 프록시 응답");
    return r;
}

// ---------- 0.0.16 HLS 확인 Referer 대안 ----------
// 사용자 확인: 실제 영상은 creatorofvideo.com/hls/<해시>/1080p.m3u8?token=… (토큰은 접속자 IP 대역·30분 제한).
// 재생 목록 요청이 거절되면(403 등) Referer·Origin 을 creatorofvideo.com, vid.jwpcdn.net 으로 바꿔 다시 확인
(function () {
    const base = DefaultExtension.prototype.directVideo;
    DefaultExtension.prototype.directVideo = async function (url, page, subs, ua) {
        try { return await base.call(this, url, page, subs, ua); }
        catch (err) {
            if (!/creatorofvideo\.com|jwpcdn\.net/i.test(String(url) + String(page))) throw err;
            for (const alt of ["https://creatorofvideo.com/", "https://vid.jwpcdn.net/"]) {
                if (String(page).startsWith(alt)) continue;
                try { return await base.call(this, url, alt, subs, ua); } catch (e) { /* 다음 */ }
            }
            throw err;
        }
    };
})();

// 앱 오류 화면은 4줄쯤만 보여 줘서, 진단은 "영상 목록" 한 줄씩으로 돌려줌(재생 불가 표시용 가짜 항목)
function hhDiag(lines) {
    return lines.map((t, i) => ({ url: "https://0.0.0.0/diag" + i, originalUrl: "https://0.0.0.0/diag" + i, quality: String(t).trim().substring(0, 200), headers: {}, subtitles: [] }));
}
