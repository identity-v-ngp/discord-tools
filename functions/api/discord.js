// ===== functions/api/discord.js =====
// 后端代理：接收前端请求，转发给 Discord API，处理速率限制

const DISCORD_API = 'https://discord.com/api/v10';

// 简单延时函数
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function onRequestPost(context) {
  const { token, method, path, body } = await context.request.json();

  // 基本校验
  if (!token || !method || !path) {
    return Response.json(
      { error: '缺少必要参数：token、method、path' },
      { status: 400 }
    );
  }

  // 构造请求头（token 只在这里使用，不记录不存储）
  const headers = {
    'Authorization': 'Bot ' + token,
    'Content-Type': 'application/json',
    'User-Agent': 'DiscordTools (1.0)'
  };

  // 构造完整 URL
  const url = DISCORD_API + (path.startsWith('/') ? path : '/' + path);

  // 带自动重试的请求逻辑（处理 429 速率限制）
  let res;
  let attempts = 0;
  const maxRetries = 5;

  while (attempts < maxRetries) {
    attempts++;

    // 发起请求
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    // 如果遇到 429 速率限制，等待后重试
    if (res.status === 429) {
      const data = await res.json();
      const waitSec = data.retry_after || 1;
      await sleep(waitSec * 1000);
      continue;
    }

    // 正常响应，跳出循环
    break;
  }

  // 请求之间加小延时，避免连续请求触发限速
  await sleep(250);

  // 读取响应内容并转发给前端
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  return Response.json(json, { status: res.status });
}
