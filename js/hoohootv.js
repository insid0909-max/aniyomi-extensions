const mangayomiSources=[{id:1543279643,name:"[시험] 후후티비",lang:"ko",baseUrl:"https://ew.hoohootv464.xyz",version:"0.0.3",isNsfw:false,itemType:1,isManga:false}];
const HH_UA="Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const HH_CATS=[["TV 전체","/tv/all"],["드라마","/tv/드라마"],["예능","/tv/Reality"],["토크쇼","/tv/Talk"],["TV 코미디","/tv/코미디"],["TV 애니메이션","/tv/애니메이션"],["TV 다큐멘터리","/tv/다큐멘터리"],["키즈","/tv/Kids"],["영화 전체","/movie/all"],["영화 - 액션","/movie/액션"],["영화 - 코미디","/movie/코미디"],["영화 - 스릴러","/movie/스릴러"],["영화 - 로맨스","/movie/로맨스"],["영화 - 공포","/movie/공포"],["영화 - 범죄","/movie/범죄"],["영화 - 애니메이션","/movie/애니메이션"],["영화 - 다큐멘터리","/movie/다큐멘터리"]];
const first=(n,s)=>{const a=n?n.select(s):[];return a.length?a[0]:null},attr=(n,k)=>String(n?.attr(k)||"").trim(),text=n=>String(n?.text||"").replace(/\s+/g," ").trim(),decode=s=>String(s||"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#0?39;/g,"'").replace(/\\\//g,"/"),origin=u=>/^https?:\/\/[^/?#]+/i.exec(String(u||""))?.[0]||"",site=u=>/^https:\/\/[a-z]{2}\.hoohootv\d+\.xyz$/i.test(String(u));
function absolute(b,v){const u=decode(v).trim();if(/^https?:\/\//i.test(u))return u;if(u.startsWith("//"))return "https:"+u;if(!u||u.startsWith("#")||/^[a-z][a-z0-9+.-]*:/i.test(u))return "";const o=origin(b),p=u.startsWith("/")?u:b.slice(o.length).replace(/[?#].*$/,"").replace(/[^/]*$/,"")+u,a=[];for(const x of p.split("/")){if(x==="..")a.pop();else if(x&&x!==".")a.push(x)}return o+"/"+a.join("/")}
function detail(u){const m=/\/detail\/([A-Za-z0-9_-]+)\/?/.exec(String(u||""));if(!m)throw Error("작품 주소 오류");return "/detail/"+m[1]+"/"}
function date(s){const m=/(20\d{2})[-.](\d{1,2})[-.](\d{1,2})/.exec(String(s||""));if(!m)return null;const t=Date.UTC(+m[1],+m[2]-1,+m[3]),d=new Date(t);return d.getUTCFullYear()===+m[1]&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[3]?String(t-32400000):null}
function episodes(html){const m=/<script\b(?=[^>]*\bid\s*=\s*["']episodes-data["'])[^>]*>([\s\S]*?)<\/script\s*>/i.exec(html);if(!m)throw Error("회차 JSON(episodes-data)이 없습니다.");let d;try{d=JSON.parse(m[1])}catch(_){throw Error("회차 JSON 형식 오류")}const map=new Map();for(const k of Object.keys(d||{}))for(const e of Array.isArray(d[k])?d[k]:[]){if(e.episode==null)continue;const season=Number(k)||1,episode=String(e.episode),day=date(e.date)||date(e.label),id=season+":"+episode,old=map.get(id);if(!old||(!old.date&&day))map.set(id,{season,episode,label:String(e.label||episode+"화"),date:day})}return [...map.values()].sort((a,b)=>a.season-b.season||Number(a.episode)-Number(b.episode)||a.episode.localeCompare(b.episode))}
class DefaultExtension extends MProvider{
pref(k,d=""){try{return String(new SharedPreferences().get("hh_test_"+k)??d)}catch(_){return d}}
save(k,v){try{new SharedPreferences().setString("hh_test_"+k,String(v))}catch(_){}}
getBaseUrl(){const m=this.pref("domain").trim().replace(/\/+$/,"");if(m&&!site(m))throw Error("후후티비의 https 주소를 입력해 주세요.");const a=this.pref("auto_domain");return m||this._site||(site(a)?a:mangayomiSources[0].baseUrl)}
get client(){return this._client||(this._client=new Client({timeout:8,connectTimeout:4}))}
getHeaders(u){const o=origin(u)||this.getBaseUrl();return {"User-Agent":HH_UA,Referer:o+"/"}}
async request(u,r){const h={Referer:r||this.getBaseUrl()+"/"};try{return await this.client.get(u,h)}catch(_){return this.client.get(u,{...h,"User-Agent":HH_UA})}}
async adopt(u){if(!site(u))return false;const r=await this.request(u+"/home",u+"/");if(Number(r.statusCode)!==200||!String(r.body).includes("/detail/"))return false;this._site=u;this.save("auto_domain",u);this._cache?.clear();return true}
async discover(){if(this.pref("auto","true")==="false"||this.pref("domain")||Date.now()-Number(this.pref("discover_at","0"))<60000)return false;this.save("discover_at",Date.now());try{const r=await this.request("https://telegra.ph/%ED%9B%84%ED%9B%84%ED%8B%B0%EB%B9%84-%EC%B5%9C%EC%8B%A0-%EC%A3%BC%EC%86%8C-09-03"),a=[...new Set(String(r.body||"").match(/https:\/\/[a-z]{2}\.hoohootv\d+\.xyz/gi)||[])];for(const u of a.slice(0,3))if(u!==this.getBaseUrl()&&await this.adopt(u))return true}catch(_){}return false}
async html(p,page=1){let r;try{r=await this.request(this.getBaseUrl()+String(p).replace(/[^\x00-\x7f]+/g,encodeURIComponent))}catch(_){if(await this.discover())return this.html(p,page);throw Error("후후티비 연결 실패. 현재 주소를 확인해 주세요.")}const s=Number(r.statusCode),b=String(r.body||"");if(s===451)throw Error("HTTP 451: 접근이 제한되었습니다.");if(s===403||/<title>\s*Just a moment|id=["']cf-chl/i.test(b))throw Error("웹뷰에서 사이트 인증을 직접 확인해 주세요.");if(s===404&&page>1)return "";if(s>=500&&await this.discover())return this.html(p,page);if(s!==200)throw Error("후후티비 HTTP "+s);return b}
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
      h = await createHlsProxyUrl(p, a);
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
mediaCandidates(body,page,doc){const out=[],seen=new Set(),add=(value,explicit=false)=>{const u=absolute(page,value),p=u.split(/[?#]/)[0];if(!/^https?:\/\//i.test(u)||/\.(?:js|css|png|jpe?g|webp|svg|vtt|srt)$/i.test(p)||(!explicit&&!/\.m3u8$/i.test(p))||seen.has(u))return;seen.add(u);out.push(u)};for(const n of doc.select("[data-m3u8]"))add(attr(n,"data-m3u8"),true);for(const n of doc.select("video[src],source[src]"))add(attr(n,"src"),/^application\/(?:x-mpegurl|vnd\.apple\.mpegurl)(?:;|$)/i.test(attr(n,"type")));const s=decode(body);for(const m of s.matchAll(/https?:\/\/[^"'\s<>\\]+\.m3u8(?:\?[^"'\s<>\\]*)?/gi))add(m[0]);return out.slice(0,4)}
async playbackSession(frame,page){let data;try{data=JSON.parse(decode(attr(frame,"data-session1")))}catch(_){throw Error("재생 세션 JSON 오류")}if(!data?.idx)throw Error("재생 세션 idx가 없습니다.");const o=origin(page),h={...this.getHeaders(page),Referer:page,Origin:o,"Content-Type":"application/json",Accept:"application/json"},r=await this.client.post(o+"/api/create_session.php",h,data);if(Number(r.statusCode)!==200)throw Error("재생 세션 HTTP "+r.statusCode);let s;try{s=JSON.parse(r.body)}catch(_){throw Error("재생 세션 응답 오류")}if(!s?.success||!/^https:\/\//.test(String(s.player_url||"")))throw Error("재생 세션 생성 실패");const url=String(s.player_url)+(s.player_url.includes("?")?"&":"?")+"t="+encodeURIComponent(s.t??"")+"&sig="+encodeURIComponent(s.sig??"");return {url,referer:page,subtitles:typeof data.vtt==="string"&&/^https?:\/\//.test(data.vtt)?[{file:data.vtt,label:"자막"}]:[]}}
async directVideo(url,page,subs){const h={"User-Agent":HH_UA,Referer:page,Origin:origin(page),Accept:"*/*"},r=await this.client.get(url,h),body=String(r.body||"").trim();if(Number(r.statusCode)!==200||!body.startsWith("#EXTM3U"))throw Error("HLS 확인 HTTP "+r.statusCode+" / 응답 "+this.responseKind(r));const out=[{url,originalUrl:url.replace(/#.*$/,"")+"#download.m3u8",quality:"자동 (HLS)",headers:h,subtitles:subs}],lines=body.split(/\r?\n/);for(let i=0;i<lines.length-1;i++){if(!lines[i].startsWith("#EXT-X-STREAM-INF:"))continue;const n=/RESOLUTION=\d+x(\d+)/.exec(lines[i])?.[1];let j=i+1;while(j<lines.length&&!lines[j].trim())j++;if(j<lines.length&&!lines[j].startsWith("#")){const u=absolute(url,lines[j].trim());if(u)out.push({url:u,originalUrl:u.replace(/#.*$/,"")+"#download.m3u8",quality:n?n+"p":"화질 "+j,headers:h,subtitles:subs})}}const want=this.pref("quality","자동");return want==="자동"?out:out.filter(x=>x.quality===want).concat(out.filter(x=>x.quality!==want))}
async getVideoList(u){const p=detail(u),q=/\?([^#]*)/.exec(String(u))?.[1]||"",path=p+(q?"?"+q:""),page=this.getBaseUrl()+path,logs=[],record=(stage,url,message)=>{logs.push(stage+" "+this.safeUrl(url)+" · "+this.safeError(message));if(logs.length>12)logs.shift();this.save("playback_diag",logs.join("\n"))};this.save("playback_diag","");let body;try{body=await this.html(path)}catch(e){record("회차",page,e);throw Error("[후후티비 0.0.3] "+logs.join(" / "))}const queue=[{url:page,body,referer:this.getBaseUrl()+"/",subtitles:[]}],queued=new Set([page]),seen=new Set(),mediaSeen=new Set(),enqueue=x=>{if(queue.length<12&&!queued.has(x.url)){queued.add(x.url);queue.push(x)}};for(let i=0;i<queue.length&&i<6;i++){const item=queue[i];if(seen.has(item.url))continue;seen.add(item.url);let b=item.body;try{if(b===undefined){const r=await this.client.get(item.url,{...this.getHeaders(item.referer),Referer:item.referer,Origin:origin(item.referer)});record("플레이어",item.url,"HTTP "+r.statusCode+" / 응답 "+this.responseKind(r));if(Number(r.statusCode)!==200)continue;b=String(r.body||"")}}catch(e){record("플레이어",item.url,e);continue}let doc;try{doc=new Document(b)}catch(e){record("문서",item.url,e);continue}for(const frame of doc.select("iframe").slice(0,6)){if(attr(frame,"data-session1")){try{enqueue(await this.playbackSession(frame,item.url))}catch(e){record("세션",item.url,e)}}const target=absolute(item.url,attr(frame,"data-src")||attr(frame,"src"));if(target)enqueue({url:target,referer:item.url,subtitles:item.subtitles})}if(/window\.TVP_CONFIG\s*=/.test(b)){try{const v=await this.castVideo(b,item.url,item.subtitles);record("완료",item.url,"TVP 인계");return v}catch(e){record("TVP",item.url,e)}}let candidates=[];try{candidates=this.mediaCandidates(b,item.url,doc)}catch(e){record("주소 판별",item.url,e)}for(const m of candidates){if(mediaSeen.has(m))continue;mediaSeen.add(m);try{const v=await this.directVideo(m,item.url,item.subtitles);record("완료",m,"HLS 확인");return v}catch(e){record("HLS 후보",m,e)}}if(!candidates.length)record("탐색",item.url,"TVP "+(/window\.TVP_CONFIG\s*=/.test(b)?"있음":"없음")+" / 후보 0 / iframe "+doc.select("iframe").length)}throw Error("[후후티비 0.0.3] 재생 실패. "+logs.slice(-5).join(" / "))}
getFilterList(){const diag=this.pref("playback_diag");return [{type_name:"HeaderFilter",name:"[시험] 후후티비 0.0.3 · 영상 주소 오탐 수정 · 실기기 미검증"},...(diag?[{type_name:"HeaderFilter",name:"최근 재생 진단:\n"+diag}]:[]),{type_name:"SelectFilter",type:"category",name:"분류",state:0,values:HH_CATS.map(([name,value])=>({type_name:"SelectOption",name,value}))},{type_name:"SelectFilter",type:"rule",name:"인기/최신 탭 규칙",state:0,values:["저장하지 않음","인기 탭에 저장","최신 탭에 저장","인기 기본값 복원","최신 기본값 복원","모두 복원"].map((name,i)=>({type_name:"SelectOption",name,value:String(i)}))},...Array.from({length:3},()=>({type_name:"HeaderFilter",name:" "}))]}
getSourcePreferences(){return [{key:"hh_test_domain",editTextPreference:{title:"후후티비 주소",summary:"비워 두면 기본 주소 사용. 직접 지정한 주소가 우선입니다.",value:"",dialogTitle:"사이트 주소",dialogMessage:"예: https://ew.hoohootv464.xyz"}},{key:"hh_test_auto",listPreference:{title:"주소 안내 확인",summary:"접속 실패 시 공개 안내 글을 확인합니다.",valueIndex:0,entries:["켬","끔"],entryValues:["true","false"]}},{key:"hh_test_quality",listPreference:{title:"선호 화질",summary:"직접 HLS에만 적용. TVP 캐스트는 앱의 자동 화질을 사용합니다.",valueIndex:0,entries:["자동","1080p","720p","480p","360p"],entryValues:["자동","1080p","720p","480p","360p"]}}]}
}
