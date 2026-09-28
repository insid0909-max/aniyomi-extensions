export async function onRequest(context) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=300",
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const START_INDEX = 51;
  const MAX_PROBE = 10;

  async function checkAlive(url) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 2500);

      // 451 차단 페이지 본문 검사를 위해 GET 요청 사용
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(id);

      // 상태 코드가 451, 403, 5xx 이면 차단된 주소
      if (res.status === 451 || res.status === 403 || res.status >= 400) {
        return false;
      }

      // 200 OK 응답이더라도 차단 안내 본문이 포함되어 있는지 확인
      const bodyText = await res.text();
      if (
        bodyText.includes("HTTP 451") ||
        bodyText.includes("법적 사유") ||
        bodyText.includes("lumendatabase")
      ) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  let activeUrl = null;
  let backupUrl = null;

  for (let i = 0; i < MAX_PROBE; i++) {
    const testUrl = `https://tvwiki${START_INDEX + i}.net`;
    if (await checkAlive(testUrl)) {
      if (!activeUrl) {
        activeUrl = testUrl;
      } else if (!backupUrl) {
        backupUrl = testUrl;
        break;
      }
    }
  }

  const payload = {
    success: true,
    tvwiki: activeUrl || `https://tvwiki${START_INDEX}.net`,
    backup: backupUrl || `https://tvwiki${START_INDEX + 1}.net`,
    notice: "정상 작동 중",
  };

  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: corsHeaders,
  });
}
