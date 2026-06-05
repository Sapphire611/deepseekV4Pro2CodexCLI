const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// 加载 .env 文件
function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}
loadEnv(path.join(__dirname, '.env'));

const PORT = 8099;
const DEEPSEEK_HOST = 'api.deepseek.com';
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY;

if (!DEEPSEEK_KEY) {
  console.error('❌ 未设置 DEEPSEEK_KEY，请在 .env 文件中配置或设置环境变量');
  process.exit(1);
}

/** DeepSeek 不支持的角色 → 映射为 system */
const ROLE_MAP = { developer: 'system' };
function mapRole(role) {
  return ROLE_MAP[role] || role;
}

/** 简单日志 */
function log(prefix, msg) {
  const ts = new Date().toISOString().split('T')[1].slice(0, 12);
  console.log(`[${ts}] ${prefix} ${msg}`);
}

/** 生成 ID */
function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/** 过滤掉 <context...> 标签及其内容（防止系统提示词泄露到输出中） */
function stripContextTags(text) {
  if (!text) return text;
  // 移除 <context>...</context> 或 <context ...>...</context> 包裹的内容
  return text.replace(/<context[^>]*>[\s\S]*?<\/context>/gi, '');
}

/**
 * 从 Responses API 消息的 content 数组中提取文本和工具调用
 * 返回 { content, tool_calls } 供 DeepSeek 消息使用
 */
function extractContentParts(contentArr) {
  if (!Array.isArray(contentArr)) return { content: contentArr || '' };

  const texts = [];
  const tool_calls = [];

  for (const part of contentArr) {
    if (part.type === 'output_text' || part.type === 'input_text') {
      texts.push(part.text || '');
    } else if (part.type === 'function_call') {
      tool_calls.push({
        id: part.call_id,
        type: 'function',
        function: { name: part.name, arguments: part.arguments },
      });
    }
    // 忽略其他类型（reasoning, image 等）
  }

  const result = {};
  if (texts.length > 0) result.content = texts.join('');
  if (tool_calls.length > 0) result.tool_calls = tool_calls;
  return result;
}

/**
 * 把 codex 的 Responses API 请求体 → DeepSeek Chat Completions 格式
 */
function translateRequest(body) {
  const messages = [];

  if (body.instructions) {
    messages.push({
      role: 'system',
      content: body.instructions + '\n\n--- 额外规则 ---\n1. 不要修改原有代码，特别是不要把中文改成乱码。\n2. 不要随便执行 lint 类的指令（如 eslint、prettier 等）。',
    });
  }

  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
      } else if (item.role) {
        const role = mapRole(item.role);
        if (Array.isArray(item.content)) {
          const parts = extractContentParts(item.content);
          messages.push({ role, ...parts });
        } else {
          messages.push({ role, content: item.content || '' });
        }
      } else if (item.type === 'input_text' || item.type === 'input_image') {
        messages.push({ role: 'user', content: item.text || '[image]' });
      } else if (item.type === 'message') {
        const role = mapRole(item.role || 'user');
        if (Array.isArray(item.content)) {
          const parts = extractContentParts(item.content);
          messages.push({ role, ...parts });
        } else {
          messages.push({ role, content: item.content || '' });
        }
      } else if (item.type === 'function_call') {
        // 把 Responses API 的 function_call → DeepSeek assistant 消息含 tool_calls
        const existingMsg = messages.length > 0 ? messages[messages.length - 1] : null;
        if (existingMsg && existingMsg.role === 'assistant' && existingMsg.tool_calls) {
          existingMsg.tool_calls.push({
            id: item.call_id,
            type: 'function',
            function: { name: item.name, arguments: item.arguments },
          });
        } else {
          messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: item.call_id,
              type: 'function',
              function: { name: item.name, arguments: item.arguments },
            }],
          });
        }
      } else if (item.type === 'function_call_output') {
        // 把 Responses API 的 function_call_output → DeepSeek tool 消息
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: item.output || '',
        });
      } else if (item.type === 'reasoning') {
        // 忽略 reasoning item — DeepSeek 不需要历史推理内容
      } else {
        log('⚠', `未知 input item: ${JSON.stringify(item).slice(0, 200)}`);
      }
    }
  }

  // 后处理：合并连续的 assistant 消息，避免 tool_calls 和 tool 响应之间被夹断
  const merged = [];
  for (const msg of messages) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : null;
    if (prev && prev.role === 'assistant' && msg.role === 'assistant') {
      if (msg.content) prev.content = (prev.content || '') + msg.content;
      if (msg.tool_calls) {
        if (!prev.tool_calls) prev.tool_calls = [];
        prev.tool_calls.push(...msg.tool_calls);
      }
    } else {
      merged.push(msg);
    }
  }

  const model = (body.model || 'deepseek-v4-pro').replace(/\[.*\]/g, '');

  const result = { model, messages: merged, stream: body.stream || false };

  if (body.max_output_tokens) result.max_tokens = body.max_output_tokens;
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.top_p != null) result.top_p = body.top_p;
  // 转换 tools 格式：Responses API（扁平）→ Chat Completions（嵌套 function）
  // 同时过滤掉 DeepSeek 不支持的工具类型（如 custom、web_search 等）
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    result.tools = body.tools
      .filter(t => {
        const toolType = (t.type || 'function').toLowerCase();
        if (toolType !== 'function') {
          log('⚠', `跳过不支持的 tool type: ${toolType} (name=${t.name || '?'})`);
          return false;
        }
        return true;
      })
      .map(t => {
        if (t.function) return t; // 已经是 Chat Completions 格式
        return {
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        };
      });
  }
  if (body.tool_choice != null) result.tool_choice = body.tool_choice;

  return result;
}

/**
 * Chat Completions 响应 → Responses API 格式（非流式）
 */
function translateResponse(chatResp, model) {
  const choice = chatResp.choices?.[0];
  if (!choice) {
    return { error: 'No choices in response', raw: chatResp };
  }

  const content = stripContextTags(choice.message?.content || '');
  const reasoning = stripContextTags(choice.message?.reasoning_content || '');

  const output = [];
  if (reasoning) {
    output.push({
      id: genId('rs'),
      type: 'reasoning',
      status: 'completed',
      content: [{ type: 'reasoning_text', text: reasoning }],
    });
  }
  output.push({
    id: genId('msg'),
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: content }],
  });

  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      output.push({
        id: genId('tc'),
        type: 'function_call',
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    }
  }

  return {
    id: 'resp_' + Date.now().toString(36),
    object: 'response',
    model,
    output,
    usage: {
      input_tokens: chatResp.usage?.prompt_tokens || 0,
      output_tokens: chatResp.usage?.completion_tokens || 0,
      total_tokens: chatResp.usage?.total_tokens || 0,
    },
  };
}

/**
 * 流式 SSE chunk 翻译 — 返回 {event, data} 数组
 */
function translateStreamChunk(parsed) {
  const choice = parsed.choices?.[0];
  if (!choice) return null;

  const delta = choice.delta || {};
  const events = [];

  if (delta.reasoning_content) {
    const filtered = stripContextTags(delta.reasoning_content);
    if (filtered) {
      events.push({
        event: 'response.reasoning_text.delta',
        data: { type: 'response.reasoning_text.delta', delta: filtered },
      });
    }
  }
  if (delta.content) {
    const filtered = stripContextTags(delta.content);
    if (filtered) {
      events.push({
        event: 'response.output_text.delta',
        data: { type: 'response.output_text.delta', delta: filtered },
      });
    }
  }
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      events.push({
        event: 'response.function_call_arguments.delta',
        data: {
          type: 'response.function_call_arguments.delta',
          call_id: tc.id || '',
          index: tc.index,
          delta: tc.function?.arguments || '',
          // 第一个 chunk 可能携带 name 和 id
          name: tc.function?.name || undefined,
        },
      });
    }
  }

  // 记录 finish_reason（如果有的话）
  if (choice.finish_reason) {
    events.push({
      event: '__internal.finish',
      data: { finish_reason: choice.finish_reason },
    });
  }

  return events.length > 0 ? events : null;
}

/** 发送 SSE 事件 */
function sendSSE(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ====== HTTP Server ======
const server = http.createServer((req, res) => {
  // 最早期的日志 — 记录每一个到达的请求
  log('🚀', `${req.method} ${req.url} from ${req.socket.remoteAddress}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-stainless-*');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  const urlPath = req.url.split('?')[0];
  const isResponsesPath = req.method === 'POST' &&
    (urlPath === '/responses' || urlPath === '/v1/responses' || urlPath === '/openai/v1/responses');

  if (isResponsesPath) {
    log('➡', `收到请求: ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('error', (e) => {
      log('💥', `请求读取错误: ${e.message}`);
    });
    req.on('end', () => {
      try {
      let reqBody;
      try {
        reqBody = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const stream = reqBody.stream || false;
      const model = reqBody.model || 'deepseek-v4-pro';

      let deepseekReq;
      try {
        deepseekReq = translateRequest(reqBody);
      } catch (e) {
        log('💥', `translateRequest 异常: ${e.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Bad request: ${e.message}` }));
        return;
      }

      log('📥', `请求: model=${model} stream=${stream} msgs=${deepseekReq.messages.length} instructions_len=${(reqBody.instructions||'').length}`);

      const postData = JSON.stringify(deepseekReq);
      log('📤', `DS请求: model=${deepseekReq.model} stream=${deepseekReq.stream} msgs=${deepseekReq.messages.length} max_tokens=${deepseekReq.max_tokens||'auto'}`);

      const options = {
        hostname: DEEPSEEK_HOST,
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEEPSEEK_KEY}`,
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const dsReq = https.request(options, dsRes => {
        const httpStatus = dsRes.statusCode;
        log('🔌', `HTTP ${httpStatus}`);

        if (httpStatus >= 400) {
          let errBody = '';
          dsRes.on('data', chunk => (errBody += chunk));
          dsRes.on('end', () => {
            log('❌', `错误 ${httpStatus}: ${errBody.slice(0, 500)}`);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `DeepSeek ${httpStatus}: ${errBody}` }));
          });
          return;
        }

        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          const responseId = genId('resp');

          // Step 1: response.created
          sendSSE(res, 'response.created', {
            type: 'response.created',
            response: {
              id: responseId,
              object: 'response',
              model,
              status: 'in_progress',
              output: [],
            },
          });

          // Step 2: response.in_progress
          sendSSE(res, 'response.in_progress', {
            type: 'response.in_progress',
            response: {
              id: responseId,
              object: 'response',
              model,
              status: 'in_progress',
              output: [],
            },
          });

          log('📡', `response.created + in_progress id=${responseId}`);

          // 输出项追踪
          const reasoningItemId = genId('rs');
          const messageItemId = genId('msg');
          // 工具调用按 DeepSeek 返回的 index 追踪：{ index: { id, call_id, name, arguments, itemSent } }
          const toolCalls = {};

          let buffer = '';
          let hasReasoning = false;
          let hasContent = false;
          let reasoningText = '';
          let contentText = '';
          let usage = null;
          let completed = false;
          let chunkCount = 0;
          let reasoningItemSent = false;
          let messageItemSent = false;

          // 计算当前非工具输出项的数量（用于确定 function_call 的 output_index）
          const nonToolItemCount = () => (hasReasoning ? 1 : 0) + (hasContent ? 1 : 0);

          const sendReasoningItemIfNeeded = () => {
            if (!reasoningItemSent && hasReasoning) {
              reasoningItemSent = true;
              sendSSE(res, 'response.output_item.added', {
                type: 'response.output_item.added',
                output_index: 0,
                item: {
                  id: reasoningItemId,
                  type: 'reasoning',
                  status: 'in_progress',
                },
              });
              log('📡', `output_item.added reasoning id=${reasoningItemId}`);
            }
          };

          const sendMessageItemIfNeeded = () => {
            if (!messageItemSent && hasContent) {
              messageItemSent = true;
              sendSSE(res, 'response.output_item.added', {
                type: 'response.output_item.added',
                output_index: hasReasoning ? 1 : 0,
                item: {
                  id: messageItemId,
                  type: 'message',
                  role: 'assistant',
                  status: 'in_progress',
                  content: [],
                },
              });
              log('📡', `output_item.added message id=${messageItemId}`);
            }
          };

          const sendToolCallItemIfNeeded = (tcIndex) => {
            const tc = toolCalls[tcIndex];
            if (!tc || tc.itemSent) return;
            tc.itemSent = true;
            const sortedIndices = Object.keys(toolCalls).map(Number).sort((a, b) => a - b);
            const outputIndex = nonToolItemCount() + sortedIndices.filter(k => k < tcIndex).length;
            sendSSE(res, 'response.output_item.added', {
              type: 'response.output_item.added',
              output_index: outputIndex,
              item: {
                id: tc.id,
                type: 'function_call',
                call_id: tc.call_id,
                name: tc.name || '',
                status: 'in_progress',
              },
            });
            log('📡', `output_item.added function_call id=${tc.id} name=${tc.name} index=${outputIndex}`);
          };

          // 发送所有未完成的工具调用完成事件（finish 或 end 时复用）
          const finalizeToolCalls = () => {
            const sortedIndices = Object.keys(toolCalls).map(Number).sort((a, b) => a - b);
            for (const idx of sortedIndices) {
              const tc = toolCalls[idx];
              sendSSE(res, 'response.function_call_arguments.done', {
                type: 'response.function_call_arguments.done',
                item_id: tc.id,
                call_id: tc.call_id,
                name: tc.name || '',
                arguments: tc.arguments,
              });
            }
            for (const idx of sortedIndices) {
              const tc = toolCalls[idx];
              const outputIndex = nonToolItemCount() + sortedIndices.filter(k => k < idx).length;
              sendSSE(res, 'response.output_item.done', {
                type: 'response.output_item.done',
                output_index: outputIndex,
                item: {
                  id: tc.id,
                  type: 'function_call',
                  call_id: tc.call_id,
                  name: tc.name || '',
                  arguments: tc.arguments,
                  status: 'completed',
                },
              });
            }
          };

          // 构建最终的 output 数组（finish 或 end 时复用）
          const buildOutputArray = () => {
            const output = [];
            if (hasReasoning) {
              output.push({
                id: reasoningItemId,
                type: 'reasoning',
                status: 'completed',
                content: [{ type: 'reasoning_text', text: reasoningText }],
              });
            }
            if (hasContent) {
              output.push({
                id: messageItemId,
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: contentText }],
              });
            }
            const sortedIndices = Object.keys(toolCalls).map(Number).sort((a, b) => a - b);
            for (const idx of sortedIndices) {
              const tc = toolCalls[idx];
              output.push({
                id: tc.id,
                type: 'function_call',
                call_id: tc.call_id,
                name: tc.name || '',
                arguments: tc.arguments,
                status: 'completed',
              });
            }
            return output;
          };

          dsRes.on('data', chunk => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;
              try {
                const parsed = JSON.parse(data);
                chunkCount++;

                if (parsed.usage) {
                  usage = parsed.usage;
                }

                const events = translateStreamChunk(parsed);
                if (events) {
                  for (const ev of events) {
                    if (ev.event === 'response.reasoning_text.delta') {
                      hasReasoning = true;
                      reasoningText += ev.data.delta;
                      sendReasoningItemIfNeeded();
                      ev.data.item_id = reasoningItemId;
                      ev.data.content_index = 0;
                    }
                    if (ev.event === 'response.output_text.delta') {
                      hasContent = true;
                      contentText += ev.data.delta;
                      sendMessageItemIfNeeded();
                      ev.data.item_id = messageItemId;
                      ev.data.content_index = 0;
                    }
                    if (ev.event === 'response.function_call_arguments.delta') {
                      const tcIndex = ev.data.index;
                      if (tcIndex === undefined || tcIndex === null) continue;
                      if (!toolCalls[tcIndex]) {
                        // 首次出现该工具调用 — 分配 item_id
                        toolCalls[tcIndex] = {
                          id: genId('tc'),
                          call_id: ev.data.call_id || '',
                          name: ev.data.name || '',
                          arguments: '',
                          itemSent: false,
                        };
                      }
                      const tc = toolCalls[tcIndex];
                      // 后续 chunk 可能补充 call_id / name
                      if (ev.data.call_id) tc.call_id = ev.data.call_id;
                      if (ev.data.name) tc.name = ev.data.name;
                      tc.arguments += (ev.data.delta || '');
                      sendToolCallItemIfNeeded(tcIndex);
                      ev.data.item_id = tc.id;
                    }
                    if (ev.event !== '__internal.finish') {
                      sendSSE(res, ev.event, ev.data);
                    }
                  }
                }

                if (parsed.choices?.[0]?.finish_reason) {
                  completed = true;
                  log('✅', `finish_reason=${parsed.choices[0].finish_reason} chunks=${chunkCount} text=${contentText.length}chars reasoning=${reasoningText.length}chars toolCalls=${Object.keys(toolCalls).length}`);

                  // 完成 reasoning
                  if (hasReasoning) {
                    sendSSE(res, 'response.reasoning_text.done', {
                      type: 'response.reasoning_text.done',
                      item_id: reasoningItemId,
                      content_index: 0,
                      text: reasoningText,
                    });
                  }
                  // 完成 message content
                  if (hasContent) {
                    sendSSE(res, 'response.content_part.done', {
                      type: 'response.content_part.done',
                      item_id: messageItemId,
                      content_index: 0,
                      part: { type: 'output_text', text: contentText },
                    });
                  }
                  // 完成所有工具调用
                  finalizeToolCalls();

                  // 完成 output items
                  if (hasReasoning) {
                    sendSSE(res, 'response.output_item.done', {
                      type: 'response.output_item.done',
                      output_index: 0,
                      item: {
                        id: reasoningItemId,
                        type: 'reasoning',
                        status: 'completed',
                        content: [{ type: 'reasoning_text', text: reasoningText }],
                      },
                    });
                  }
                  if (hasContent) {
                    sendSSE(res, 'response.output_item.done', {
                      type: 'response.output_item.done',
                      output_index: hasReasoning ? 1 : 0,
                      item: {
                        id: messageItemId,
                        type: 'message',
                        role: 'assistant',
                        status: 'completed',
                        content: [{ type: 'output_text', text: contentText }],
                      },
                    });
                  }

                  // response.completed
                  sendSSE(res, 'response.completed', {
                    type: 'response.completed',
                    response: {
                      id: responseId,
                      object: 'response',
                      model,
                      status: 'completed',
                      output: buildOutputArray(),
                      usage: usage ? {
                        input_tokens: usage.prompt_tokens || 0,
                        output_tokens: usage.completion_tokens || 0,
                        total_tokens: usage.total_tokens || 0,
                      } : null,
                    },
                  });
                  log('📡', 'response.completed');
                }
              } catch (e) {
                res.write(line + '\n');
              }
            }
          });

          dsRes.on('end', () => {
            if (!completed) {
              log('⚠', '流结束但未收到 finish_reason，补发');
              sendReasoningItemIfNeeded();
              sendMessageItemIfNeeded();
              // 补发所有工具调用的 output_item.added
              const sortedIndices = Object.keys(toolCalls).map(Number).sort((a, b) => a - b);
              for (const idx of sortedIndices) {
                sendToolCallItemIfNeeded(idx);
              }
              if (hasReasoning) {
                sendSSE(res, 'response.reasoning_text.done', {
                  type: 'response.reasoning_text.done',
                  item_id: reasoningItemId,
                  content_index: 0,
                  text: reasoningText,
                });
                sendSSE(res, 'response.output_item.done', {
                  type: 'response.output_item.done',
                  output_index: 0,
                  item: { id: reasoningItemId, type: 'reasoning', status: 'completed', content: [{ type: 'reasoning_text', text: reasoningText }] },
                });
              }
              if (hasContent) {
                sendSSE(res, 'response.content_part.done', {
                  type: 'response.content_part.done',
                  item_id: messageItemId,
                  content_index: 0,
                  part: { type: 'output_text', text: contentText },
                });
                sendSSE(res, 'response.output_item.done', {
                  type: 'response.output_item.done',
                  output_index: hasReasoning ? 1 : 0,
                  item: { id: messageItemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: contentText }] },
                });
              }
              finalizeToolCalls();
              sendSSE(res, 'response.completed', {
                type: 'response.completed',
                response: {
                  id: responseId, object: 'response', model, status: 'completed',
                  output: buildOutputArray(),
                  usage: usage ? { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0, total_tokens: usage.total_tokens || 0 } : null,
                },
              });
            }
            res.write('data: [DONE]\n\n');
            res.end();
            log('🏁', `响应结束 completed=${completed} text=${contentText.length}chars toolCalls=${Object.keys(toolCalls).length}`);
          });

          dsRes.on('error', e => {
            log('💥', `流错误: ${e.message}`);
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: e.message }));
            } else {
              res.end();
            }
          });
        } else {
          let dsBody = '';
          dsRes.on('data', chunk => (dsBody += chunk));
          dsRes.on('end', () => {
            try {
              const chatResp = JSON.parse(dsBody);
              const translated = translateResponse(chatResp, model);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(translated));
              log('✅', `非流式输出 ${translated.usage?.output_tokens || 0} tokens`);
            } catch (e) {
              log('❌', `解析失败: ${e.message}`);
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to parse response' }));
            }
          });
        }
      });

      dsReq.on('error', e => {
        log('💥', `连接失败: ${e.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      dsReq.write(postData);
      dsReq.end();
      } catch (e) {
        log('💥', `请求处理异常: ${e.message}`);
        console.error(e.stack);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Internal error: ${e.message}` }));
        }
      }
    });
  } else {
    log('❓', `未知路径: ${req.method} ${req.url}`);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌ 端口 ${PORT} 已被占用！请先关闭旧进程。`);
    console.error(`   查找占用进程: netstat -ano | findstr ${PORT}`);
  } else {
    console.error('❌ 服务启动失败:', e.message);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  🔄 Codex → DeepSeek Proxy              ║');
  console.log(`║  Listening: http://127.0.0.1:${PORT}       ║`);
  console.log(`║  Target:    https://${DEEPSEEK_HOST}/v1   ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log(`[${new Date().toISOString()}] ✅ 代理启动成功`);
});

// 全局异常捕获，防止进程静默崩溃
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] 💥 未捕获异常:`, err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[${new Date().toISOString()}] 💥 未处理的 Promise 拒绝:`, reason);
});
