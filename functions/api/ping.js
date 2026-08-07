// Cloudflare Pages Function - 处理 GET /api/ping 请求
// 导出 onRequestGet 表示只响应 GET 请求
export async function onRequestGet(context) {
  return Response.json({
    status: "ok",
    message: "后端连接成功 ✅"
  });
}
