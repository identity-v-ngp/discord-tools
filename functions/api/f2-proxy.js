// ===== functions/api/f2-proxy.js =====
// F2（Discord 活动频道归档）专属的 Cloudflare Pages Function 后端代理
//
// 【这个文件是干什么的？】（写给非技术的使用者）
// 浏览器如果直接去调用 Discord 官方网站的接口，会被浏览器的"跨域(CORS)"安全策略拦下来，
// 而且把 Bot Token 直接写在前端也不安全。所以前端把请求先发到我们自己这个接口，
// 由 Cloudflare 的服务器"替我们"去请求 Discord。服务器只负责转发，
// 不负责业务逻辑（比如搬运多少条消息、怎么翻页），那些都由前端决定。
//
// 【前端怎么调用？】
//   方法：POST
//   路径：/api/f2-proxy
//   请求体（JSON）：
//     {
//       "token":  "你的 Bot Token",   // 必填，用完即弃，本文件不会记录也不会存储
//       "action": "动作名",            // 必填，见下面的"支持的动作"
//       "params": { ... },            // 动作需要的路径参数（比如频道 ID）
//       "body":   { ... }             // 只有 POST 类动作需要（比如发消息的内容）
//     }
//
// 【支持的动作（action）一共 4 个】
//   1. getChannel    → GET  /channels/{channelId}
//                      获取频道信息。归档前可以先看看源频道是不是论坛类型。
//                      需要参数：params.channelId
//
//   2. getMessages   → GET  /channels/{channelId}/messages?limit=&before=&after=
//                      分页拉取频道历史消息。前端可以反复调用它来一页一页地把消息取完。
//                      需要参数：params.channelId
//                      可选参数：params.limit（1~100，一次最多取多少条）
//                                params.before（取比这条消息 ID 更早的消息）
//                                params.after （取比这条消息 ID 更晚的消息）
//
//   3. createThread  → POST /channels/{forumId}/threads
//                      在目标论坛频道里创建一个新帖子（Discord 里叫 Thread）。
//                      需要参数：params.forumId（目标论坛的频道 ID）
//                      需要 body：创建帖子要带的内容，例如 { name: "帖子标题", message: {...} }
//
//   4. sendMessage   → POST /channels/{channelId}/messages
//                      往某个频道或帖子（帖子对外也是一个频道，可以直接用它的 ID）发消息。
//                      需要参数：params.channelId（频道 ID 或帖子 ID）
//                      需要 body：消息内容，例如 { content: "文字", embeds: [...] }
//
//   5. getActiveThreads   → GET /channels/{channelId}/threads/active
//                           获取论坛里"还能看到、没有被归档"的活跃帖子。
//                           需要参数：params.channelId（论坛频道 ID）
//                           可选参数：params.guildId（服务器 ID）
//                           小说明：Discord 官方的活跃帖子接口其实是挂在【服务器】下的
//                                   （/guilds/{guildId}/threads/active）。所以如果前端同时
//                                   传了 params.guildId，本文件会优先用服务器级别的正确地址；
//                                   只传 channelId 时才按频道级别尝试。
//
//   6. getArchivedThreads → GET /channels/{channelId}/threads/archived/public
//                           获取论坛里"已经被归档收起来"的帖子，结果里带 has_more，
//                           前端可以配合 before 参数一页页翻完。
//                           需要参数：params.channelId（论坛频道 ID）
//                           可选参数：params.limit（1~100）、params.before（翻页游标）
//
// 【重要的设计原则（请务必保持）】
//   * 本文件只做"单次转发"，一个请求对应一次 Discord 请求。
//     ★ 绝对不要在后端写"循环搬运消息"的逻辑，翻页和批量搬运全部由前端控制。★
//   * 遇到 429（请求太频繁被限流）或 403（没有权限）时，本文件不会自己偷偷重试，
//     而是把 Discord 返回的状态码和内容【原样】交回给前端。
//     由前端决定"要不要等、等多久、要不要重试"。
//   * 本文件与 F1 / F3 使用的 functions/api/discord.js 完全独立，互不影响。

// Discord API 的固定前缀（本文件不用改这里）
const DISCORD_API = 'https://discord.com/api/v10';

/**
 * 把"动作名 + 参数"翻译成真正要请求 Discord 的【请求方法】和【路径】。
 * 只有写在下面白名单里的动作才允许被转发，这样可以防止前端拼出任意路径去访问 Discord。
 *
 * @param {string} action - 动作名，见文件顶部说明
 * @param {object} params - 前端传来的参数对象
 * @returns {{method?: string, path?: string, error?: string}}
 *          成功时返回 { method, path }；失败时返回 { error: "提示文字" }
 */
function buildDiscordRequest(action, params) {
  // p 是参数的简写，防止 params 没传导致后面报错
  const p = params || {};

  switch (action) {

    // ---------- 动作 1：获取频道信息 ----------
    case 'getChannel': {
      if (!p.channelId) {
        return { error: '缺少参数 params.channelId（频道 ID）' };
      }
      return { method: 'GET', path: '/channels/' + p.channelId };
    }

    // ---------- 动作 2：分页拉取历史消息 ----------
    case 'getMessages': {
      if (!p.channelId) {
        return { error: '缺少参数 params.channelId（频道 ID）' };
      }

      // 把三个可选的分页参数拼成 Discord 需要的查询字符串（?limit=..&before=..）
      const queryParts = [];

      // limit：一次取多少条。只有前端传了才带上，没传就让 Discord 用它自己的默认值
      if (p.limit !== undefined && p.limit !== null && p.limit !== '') {
        const limit = parseInt(p.limit, 10);
        // Discord 规定一次最多只能取 100 条，这里提前帮前端拦住不合法的数字
        if (isNaN(limit) || limit < 1 || limit > 100) {
          return { error: 'params.limit 必须是 1 到 100 之间的整数（Discord 单次最多返回 100 条消息）' };
        }
        queryParts.push('limit=' + limit);
      }

      // before：取比这条消息更早的消息（用于往前翻页）
      if (p.before) {
        queryParts.push('before=' + encodeURIComponent(p.before));
      }

      // after：取比这条消息更晚的消息（用于往后翻页）
      if (p.after) {
        queryParts.push('after=' + encodeURIComponent(p.after));
      }

      const queryString = queryParts.length > 0 ? '?' + queryParts.join('&') : '';
      return { method: 'GET', path: '/channels/' + p.channelId + '/messages' + queryString };
    }

    // ---------- 动作 3：在目标论坛创建一个新帖子（Thread） ----------
    case 'createThread': {
      if (!p.forumId) {
        return { error: '缺少参数 params.forumId（目标论坛频道 ID）' };
      }
      return { method: 'POST', path: '/channels/' + p.forumId + '/threads' };
    }

    // ---------- 动作 4：往帖子（或频道）里发送一条消息 ----------
    case 'sendMessage': {
      if (!p.channelId) {
        return { error: '缺少参数 params.channelId（频道 ID 或帖子 ID）' };
      }
      return { method: 'POST', path: '/channels/' + p.channelId + '/messages' };
    }

    // ---------- 动作 5：获取论坛的活跃帖子 ----------
    case 'getActiveThreads': {
      // Discord 官方的"活跃帖子"接口是挂在【服务器(guild)】下面的，所以有 guildId 时优先用它
      if (p.guildId) {
        return { method: 'GET', path: '/guilds/' + p.guildId + '/threads/active' };
      }
      // 没有服务器 ID 时，退一步按频道级别尝试
      if (!p.channelId) {
        return { error: '缺少参数：请提供 params.guildId（服务器 ID）或 params.channelId（论坛频道 ID）' };
      }
      return { method: 'GET', path: '/channels/' + p.channelId + '/threads/active' };
    }

    // ---------- 动作 6：获取论坛的已归档帖子 ----------
    case 'getArchivedThreads': {
      if (!p.channelId) {
        return { error: '缺少参数 params.channelId（论坛频道 ID）' };
      }

      // 组装可选参数（limit / before），前端没传就不带
      const queryParts = [];

      // limit：这一页最多取多少个
      if (p.limit !== undefined && p.limit !== null && p.limit !== '') {
        const limit = parseInt(p.limit, 10);
        if (isNaN(limit) || limit < 1 || limit > 100) {
          return { error: 'params.limit 必须是 1 到 100 之间的整数（Discord 单次最多返回 100 个帖子）' };
        }
        queryParts.push('limit=' + limit);
      }

      // before：翻页游标（用上一页最后一个帖子的归档时间），取更早的帖子
      if (p.before) {
        queryParts.push('before=' + encodeURIComponent(p.before));
      }

      const queryString = queryParts.length > 0 ? '?' + queryParts.join('&') : '';
      return { method: 'GET', path: '/channels/' + p.channelId + '/threads/archived/public' + queryString };
    }

    // ---------- 不在白名单里的动作一律拒绝 ----------
    default:
      return { error: '不支持的动作 action：' + action + '（只支持 getChannel / getMessages / createThread / sendMessage / getActiveThreads / getArchivedThreads）' };
  }
}

/**
 * Cloudflare Pages Function 的入口函数。
 * 函数名 onRequestPost 表示：只处理前端发来的 POST 请求。
 *
 * 整体流程只有三步：
 *   接收前端请求 → 替前端请求 Discord → 把 Discord 的返回原样送回前端
 */
export async function onRequestPost(context) {

  // ===== 第 0 步：读取前端发来的 JSON 请求体 =====
  let payload;
  try {
    payload = await context.request.json();
  } catch {
    // 前端传来的不是合法 JSON，直接返回 400（Bad Request）
    return Response.json({ error: '请求体不是合法的 JSON 格式' }, { status: 400 });
  }

  // 从请求体里取出四个部分（没传的就是 undefined）
  const { token, action, params, body } = payload;

  // ===== 第 1 步：基本参数校验 =====
  if (!token) {
    return Response.json({ error: '缺少必要参数：token（Bot Token）' }, { status: 400 });
  }
  if (!action) {
    return Response.json({ error: '缺少必要参数：action（要执行的动作名）' }, { status: 400 });
  }

  // ===== 第 2 步：用白名单把动作翻译成真实的请求方法 + 路径 =====
  const plan = buildDiscordRequest(action, params);

  // 如果翻译失败（动作不支持，或缺少必须的参数），把原因告诉前端
  if (plan.error) {
    return Response.json({ error: plan.error }, { status: 400 });
  }

  // POST 类动作（创建帖子、发消息）必须带 body。
  // 这里提前检查一下，好给前端一句清楚的中文提示（否则要等 Discord 报错才知道原因）
  if (plan.method === 'POST' && !body) {
    return Response.json(
      { error: '动作 ' + action + ' 需要提供 body（要发送的内容）' },
      { status: 400 }
    );
  }

  // ===== 第 3 步：替前端去请求 Discord =====
  const url = DISCORD_API + plan.path;

  let res;
  try {
    res = await fetch(url, {
      method: plan.method,
      headers: {
        // Bot Token 只在这一次请求里使用，本文件不打印、不记录、不存储
        'Authorization': 'Bot ' + token,
        'Content-Type': 'application/json',
        'User-Agent': 'DiscordTools (1.0)'
      },
      // 只有 POST 才需要请求体；GET 请求不能带 body
      body: plan.method === 'POST' ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    // 网络层面的问题（比如连不上 Discord），返回 502（网关错误）
    return Response.json({ error: '无法连接到 Discord：' + err.message }, { status: 502 });
  }

  // ===== 第 4 步：把 Discord 的响应原样转回给前端 =====
  // 注意：这里【不判断】状态码是否成功，也不重试。
  // 如果 Discord 返回 429（限流）或 403（权限不足），会连同状态码一起交给前端，
  // 由前端自己决定等待多久、是否重试。
  const text = await res.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // 极少情况下 Discord 返回的不是 JSON（比如网关错误页），就包一层 raw 字段
    json = { raw: text };
  }

  // 把 Discord 的状态码和响应内容原样返回（前端可以用 res.status 判断是否成功）
  return Response.json(json, { status: res.status });
}
