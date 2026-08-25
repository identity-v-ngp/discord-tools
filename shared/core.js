// ===== shared/core.js =====
// 所有工具页面共用的函数库

// ========== 可调常量 ==========
// 每次请求之间的等待时间（毫秒），调大可降低限流风险，调小可加快速度
export const REQUEST_DELAY_MS = 400;
// 单个请求失败后最多重试次数（含首次请求共 MAX_RETRIES+1 次尝试）
export const MAX_RETRIES = 3;
// ==============================

// 延时函数
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 创建 token 输入框并插入到指定容器中
 * @param {HTMLElement} container - 要把输入框放进去的父元素
 * @returns {HTMLInputElement} 返回输入框元素，方便后续读取值
 */
export function createTokenInput(container) {
  const wrapper = document.createElement('div');
  wrapper.className = 'token-row';

  const label = document.createElement('label');
  label.textContent = 'Bot Token（用完即弃，不会存储）';
  label.setAttribute('for', 'tokenInput');

  const input = document.createElement('input');
  input.type = 'password';          // 密码框，输入时隐藏字符
  input.id = 'tokenInput';
  input.placeholder = '粘贴你的 Bot Token';
  input.autocomplete = 'off';       // 禁止浏览器自动填充

  wrapper.appendChild(label);
  wrapper.appendChild(input);
  container.appendChild(wrapper);

  return input;
}

/**
 * 统一调用 Discord API 的函数（带自动重试和延迟）
 * 所有请求都经过后端代理 /api/discord，避免浏览器 CORS 限制
 *
 * - 遇到 429（限流）或 403（禁止）时自动重试，最多重试 MAX_RETRIES 次
 * - 每次请求后自动等待 REQUEST_DELAY_MS 毫秒
 * - 通过 onRetry 回调通知外部重试状态（用于进度显示）
 *
 * @param {string} token  - Bot Token
 * @param {string} method - HTTP 方法，如 "GET"、"POST"
 * @param {string} path   - Discord API 路径，如 "/channels/123/messages"
 * @param {object|null} body - 请求体（POST/PUT 时用），GET 时传 null
 * @param {Function|null} onRetry - 重试回调 (attempt, waitSec) => {}，可选
 * @returns {Promise<any>} 返回 Discord API 的 JSON 响应
 */
export async function callDiscord(token, method, path, body = null, onRetry = null) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // 非首次请求前等待（重试间隔）
    if (attempt > 0) {
      // 默认等 1 秒，如果上次响应指定了 Retry-After 就用那个值
      const waitSec = lastError && lastError.retryAfter
        ? lastError.retryAfter
        : 1;
      // 通知外部正在重试
      if (onRetry) onRetry(attempt, waitSec);
      await sleep(waitSec * 1000);
    }

    const res = await fetch('/api/discord', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, method, path, body })
    });

    // 成功响应
    if (res.ok) {
      // 请求之间加延迟，避免连续请求触发限速
      await sleep(REQUEST_DELAY_MS);
      return res.json();
    }

    // 可重试的状态码：429（限流）、403（禁止，可能是临时限流）
    if (res.status === 429 || res.status === 403) {
      let retryAfter = null;
      try {
        const data = await res.json();
        // Discord 429 响应里的 retry_after 字段（秒）
        retryAfter = data.retry_after || null;
      } catch {
        // 解析失败就忽略，用默认等待时间
      }
      lastError = { status: res.status, retryAfter };
      continue; // 重试
    }

    // 其他错误（如 404、500 等）不重试，直接抛出
    const errText = await res.text();
    throw new Error('API 请求失败 (' + res.status + '): ' + errText);
  }

  // 所有重试都失败了
  const status = lastError ? lastError.status : '未知';
  throw new Error('请求在 ' + MAX_RETRIES + ' 次重试后仍然失败 (HTTP ' + status + ')');
}
