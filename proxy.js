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

/**
 * 把 codex 的 Responses API 请求体 → DeepSeek Chat Completions 格式
 */
function translateRequest(body) {
  const messages = [];

  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
      } else if (item.role) {
        if (Array.isArray(item.content)) {
          const text = item.content
            .filter(c => c.type === 'output_text' || c.type === 'input_text')
            .map(c => c.text)
            .join('');
          messages.push({ role: mapRole(item.role), content: text });
        } else {
          messages.push({ role: mapRole(item.role), content: item.content || '' });
        }
      } else if (item.type === 'input_text' || item.type === 'input_image') {
        messages.push({ role: 'user', content: item.text || '[image]' });
      } else if (item.type === 'message') {
        const content = Array.isArray(item.content)
          ? item.content.filter(c => c.type === 'input_text' || c.type === 'output_text').map(c => c.text).join('')
          : (item.content || '');
        messages.push({ role: mapRole(item.role || 'user'), content });
      } else {
        log('⚠', `未知 input item: ${JSON.stringify(item).slice(0, 200)}`);
      }
    }
  }

  const model = (body.model || 'deepseek-v4-pro').replace(/\[.*\]/g, '');

  const result = { model, messages, stream: body.stream || false };

  if (body.max_output_tokens) result.max_tokens = body.max_output_tokens;
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.top_p != null) result.top_p = body.top_p;

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

  const content = choice.message?.content || '';
  const reasoning = choice.message?.reasoning_content || '';

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
    events.push({
      event: 'response.reasoning_text.delta',
      data: { type: 'response.reasoning_text.delta', delta: delta.reasoning_content },
    });
  }
  if (delta.content) {
    events.push({
      event: 'response.output_text.delta',
      data: { type: 'response.output_text.delta', delta: delta.content },
    });
  }
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      events.push({
        event: 'response.function_call_arguments.delta',
        data: {
          type: 'response.function_call_arguments.delta',
          call_id: tc.id || tc.index?.toString(),
          delta: tc.function?.arguments || '',
        },
      });
    }
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

  const isResponsesPath = req.method === 'POST' &&
    (req.url === '/responses' || req.url === '/v1/responses' || req.url === '/openai/v1/responses');

  if (isResponsesPath) {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
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
      const deepseekReq = translateRequest(reqBody);

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

          // 输出项：reasoning 和 message 各分配一个 item_id
          const reasoningItemId = genId('rs');
          const messageItemId = genId('msg');

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
                      // 注入 item_id 和 content_index
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
                    sendSSE(res, ev.event, ev.data);
                  }
                }

                if (parsed.choices?.[0]?.finish_reason) {
                  completed = true;
                  log('✅', `finish_reason=${parsed.choices[0].finish_reason} chunks=${chunkCount} text=${contentText.length}chars reasoning=${reasoningText.length}chars`);

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

                  // 更新 output item 状态
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

                  sendSSE(res, 'response.completed', {
                    type: 'response.completed',
                    response: {
                      id: responseId,
                      object: 'response',
                      model,
                      status: 'completed',
                      output,
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
              // 补发 output item added...
              sendReasoningItemIfNeeded();
              sendMessageItemIfNeeded();
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
              const output = [];
              if (hasReasoning) output.push({ id: reasoningItemId, type: 'reasoning', status: 'completed', content: [{ type: 'reasoning_text', text: reasoningText }] });
              if (hasContent) output.push({ id: messageItemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: contentText }] });
              sendSSE(res, 'response.completed', {
                type: 'response.completed',
                response: {
                  id: responseId, object: 'response', model, status: 'completed', output,
                  usage: usage ? { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0, total_tokens: usage.total_tokens || 0 } : null,
                },
              });
            }
            res.write('data: [DONE]\n\n');
            res.end();
            log('🏁', `响应结束 completed=${completed} text=${contentText.length}chars`);
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
    });
  } else {
    log('❓', `未知路径: ${req.method} ${req.url}`);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  🔄 Codex → DeepSeek Proxy              ║');
  console.log(`║  Listening: http://127.0.0.1:${PORT}       ║`);
  console.log(`║  Target:    https://${DEEPSEEK_HOST}/v1   ║`);
  console.log('╚══════════════════════════════════════════╝');
});
