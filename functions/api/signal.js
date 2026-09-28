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
      const id = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(url, {
        method: "HEAD",
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(id);
      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    }
  }

  let activeUrl = null;
  let backupUrl = null;

  for (let i = 0; i < MAX_PROBE; i++) {
    const testUrl = `https://tvwiki${START_INDEX + i}.net`;
    if (await checkAlive(testUrl)) {
      if (!activeUrl) activeUrl = testUrl;
      else if (!backupUrl) {
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
