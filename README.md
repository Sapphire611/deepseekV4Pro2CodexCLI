# Codex → DeepSeek Proxy

将 OpenAI Codex CLI 的 [Responses API](https://platform.openai.com/docs/api-reference/responses) 请求转换为 [DeepSeek Chat Completions API](https://api-docs.deepseek.com/) 格式的本地代理，让你在 Codex 中使用 DeepSeek 模型。

## 快速开始

### 1. 配置 API Key

```bash
cp .env.example .env
```

编辑 `.env`，填入你的 DeepSeek API Key：

```
DEEPSEEK_KEY=sk-your-deepseek-api-key
```

### 2. 启动代理

```bash
node proxy.js
```

代理会监听 `http://127.0.0.1:8099`。

### 3. 配置 Codex

编辑 `~/.codex/config.toml`（Windows: `C:\Users\<用户名>\.codex\config.toml`）：

```toml
model = "deepseek-v4-pro[1m]"
model_provider = "proxy"
model_reasoning_effort = "xhigh"
model_context_window = 1000000
model_auto_compact_token_limit = 900000
model_supports_reasoning_summaries = true
model_catalog_json = "C:\\Users\\<用户名>\\.codex\\model_catalog.json"

[model_providers.proxy]
name = "DeepSeek via Proxy"
base_url = "http://127.0.0.1:8099"
env_key = "OPENAI_API_KEY"
```

> `env_key` 可以填任意值（如 `OPENAI_API_KEY`），代理不校验，但 Codex 要求该字段存在。

### 4. 配置模型元数据

创建 `~/.codex/model_catalog.json`（Windows: `C:\Users\<用户名>\.codex\model_catalog.json`）：

```json
{
  "models": [
    {
      "slug": "deepseek-v4-pro",
      "display_name": "DeepSeek V4 Pro",
      "description": "DeepSeek V4 Pro with 1M context window",
      "default_reasoning_level": "medium",
      "supported_reasoning_levels": [
        {"effort": "none", "description": "No reasoning"},
        {"effort": "low", "description": "Fast responses with lighter reasoning"},
        {"effort": "medium", "description": "Balances speed and reasoning depth"},
        {"effort": "high", "description": "Greater reasoning depth for complex problems"},
        {"effort": "xhigh", "description": "Maximum reasoning depth"}
      ],
      "shell_type": "shell_command",
      "visibility": "list",
      "supported_in_api": true,
      "priority": 100,
      "additional_speed_tiers": [],
      "availability_nux": null,
      "upgrade": null,
      "base_instructions": "You are a coding agent based on DeepSeek V4 Pro.",
      "model_messages": {
        "instructions_template": "You are a coding agent based on DeepSeek V4 Pro.\n",
        "instructions_variables": {
          "personality_default": "",
          "personality_friendly": "",
          "personality_pragmatic": ""
        }
      },
      "supports_reasoning_summaries": true,
      "default_reasoning_summary": "none",
      "support_verbosity": false,
      "default_verbosity": "low",
      "apply_patch_tool_type": "freeform",
      "web_search_tool_type": "text_and_image",
      "truncation_policy": { "mode": "tokens", "limit": 10000 },
      "supports_parallel_tool_calls": true,
      "supports_image_detail_original": false,
      "context_window": 1000000,
      "max_context_window": 1000000,
      "effective_context_window_percent": 95,
      "experimental_supported_tools": [],
      "input_modalities": ["text"],
      "supports_search_tool": false
    }
  ]
}
```

> 将 `<用户名>` 替换为你的 Windows 用户名。

### 5. 启动 Codex

```bash
codex
```

看到 `model: deepseek-v4-pro[1m]` 且没有 metadata warning 即配置成功。

## 模型后缀说明

`[1m]` 表示 1M（100万）token 上下文窗口。如需其他窗口大小：

| 后缀 | 上下文窗口 | `context_window` |
|------|-----------|-----------------|
| `[1m]` | 1,000,000 | `1000000` |
| `[500k]` | 500,000 | `500000` |
| `[128k]` | 128,000 | `128000` |

修改 `config.toml` 中的 `model`、`model_context_window`、`model_auto_compact_token_limit` 和 `model_catalog.json` 中的 `context_window`、`max_context_window` 保持一致即可。

## 文件说明

```
codex-proxy/
├── proxy.js            # 代理主程序
├── start.bat           # 双击启动（Windows）
├── proxy-explained.html # 源码解析文档
├── .env                # API Key 配置（不提交）
├── .env.example        # API Key 配置模板
└── README.md           # 本文件
```

## 故障排查

代理会在控制台输出详细日志，包括请求/响应摘要和 SSE 事件流。常见问题：

- **`Model metadata not found`** — 检查 `model_catalog_json` 路径是否正确，JSON 格式是否完整
- **`stream disconnected before completion`** — 代理版本过旧，拉取最新 `proxy.js`
- **codex 无输出** — 同上，旧版缺少 `output_item.added` 等关键事件
