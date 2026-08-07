// ===== shared/core.js =====
// 所有工具页面共用的函数库

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
 * 统一调用 Discord API 的函数
 * 所有请求都经过后端代理 /api/discord，避免浏览器 CORS 限制
 *
 * @param {string} token  - Bot Token
 * @param {string} method - HTTP 方法，如 "GET"、"POST"
 * @param {string} path   - Discord API 路径，如 "/channels/123/messages"
 * @param {object|null} body - 请求体（POST/PUT 时用），GET 时传 null
 * @returns {Promise<any>} 返回 Discord API 的 JSON 响应
 */
export async function callDiscord(token, method, path, body = null) {
  const res = await fetch('/api/discord', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, method, path, body })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('API 请求失败 (' + res.status + '): ' + errText);
  }

  return res.json();
}
