import { tool } from "@opencode-ai/plugin/tool";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function parseJsonObject(value, label) {
  if (value === undefined || value === null || value === "") {
    return {};
  }
  if (typeof value !== "string") {
    throw new Error(`[mcphub] ${label} must be a JSON string`);
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[mcphub] Invalid ${label}: ${msg}`);
  }
}

function pickMcphubConfig(opencodeConfig) {
  const name = process.env.MCPHUB_MCP_NAME || "mcphub";
  const mcpEntry = opencodeConfig?.mcp?.[name];

  const url = process.env.MCPHUB_URL || mcpEntry?.url;

  const envAuth =
    process.env.MCPHUB_AUTH ||
    process.env.MCPHUB_AUTHORIZATION ||
    process.env.MCPHUB_AUTHORIZATION_HEADER;

  const headers = {
    ...(mcpEntry?.headers && typeof mcpEntry.headers === "object" ? mcpEntry.headers : {})
  };

  if (envAuth) {
    headers.Authorization = envAuth;
  }

  return { name, url, headers };
}

function validateMcphubConfig(config) {
  if (!config.url) {
    throw new Error(
      "[mcphub] Missing mcphub URL. Configure it in opencode.json under mcp.mcphub.url (or set MCPHUB_URL)."
    );
  }

  const auth = config.headers?.Authorization;
  if (!auth) {
    throw new Error(
      "[mcphub] Missing Authorization header. Configure mcp.mcphub.headers.Authorization (or set MCPHUB_AUTH)."
    );
  }

  if (typeof auth !== "string" || auth.trim().length === 0) {
    throw new Error("[mcphub] Authorization header must be a non-empty string");
  }
}

function formatCallToolResult(result) {
  const content = result?.content;
  if (Array.isArray(content) && content.length === 1 && content[0]?.type === "text") {
    return String(content[0]?.text ?? "");
  }
  if (content !== undefined) {
    return JSON.stringify(content, null, 2);
  }
  return JSON.stringify(result, null, 2);
}

function isTimeoutError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("Request timed out") || msg.includes("MCP error -32001");
}

function isPotentiallyMutatingToolName(name) {
  return /(create|delete|update|merge|rename|add|remove|complete|dispose|run|start|logout|auth|upload|install)/i.test(
    name
  );
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries(fn, retries) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isTimeoutError(err)) {
        throw err;
      }
      await sleep(250 * Math.min(attempt + 1, 8));
    }
  }
  throw lastErr;
}

function getTransportMode(url) {
  const hint = String(process.env.MCPHUB_TRANSPORT ?? "").toLowerCase();
  if (hint === "sse") return "sse";
  if (hint === "http" || hint === "streamablehttp" || hint === "streamable") return "http";
  const u = String(url);
  if (u.endsWith("/sse") || u.includes("/sse?")) return "sse";
  return "http";
}

async function createTransport(url, headers) {
  const requestInit = { headers };
  const mode = getTransportMode(url);
  if (mode === "sse") {
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    return new SSEClientTransport(new URL(url), { requestInit });
  }
  return new StreamableHTTPClientTransport(new URL(url), { requestInit });
}

export default async function McpHubBridgePlugin() {
  let opencodeConfig = null;

  let session = null;

  function makeSessionKey(url, headers) {
    const mode = getTransportMode(url);
    return `${mode}::${url}::${JSON.stringify(headers ?? {})}`;
  }

  async function closeSession() {
    const current = session;
    session = null;
    if (!current) return;

    try {
      await current.client.close();
    } catch (err) {
      void err;
    }
    try {
      await current.transport.close();
    } catch (err) {
      void err;
    }
  }

  async function getClient(url, headers) {
    const key = makeSessionKey(url, headers);
    if (!session || session.key !== key) {
      await closeSession();
      const transport = await createTransport(url, headers);
      const client = new Client(
        { name: "opencode-mcphub-bridge", version: "0.1.3" },
        { capabilities: {} }
      );
      const connectPromise = client.connect(transport);
      session = { key, transport, client, connectPromise };
    }

    try {
      await session.connectPromise;
    } catch (err) {
      await closeSession();
      throw err;
    }

    return session.client;
  }

  async function callMcphubTool({ url, headers }, toolName, toolArguments) {
    const client = await getClient(url, headers);
    return await client.callTool({ name: toolName, arguments: toolArguments });
  }

  return {
    config: async (config) => {
      opencodeConfig = config;
    },

    tool: {
      mcphub_search_tools: tool({
        description: "在 MCPHub 聚合层搜索可用工具（等价于远程的 search_tools）",
        args: {
          query: tool.schema.string().min(1).describe("Search query"),
          limit: tool.schema.number().int().min(1).max(200).optional().describe("Max results"),
          retries: tool.schema.number().int().min(0).max(3).optional().describe("Retry count on timeout"),
          raw: tool.schema.boolean().optional().describe("Return raw MCP result")
        },
        async execute(args) {
          const cfg = pickMcphubConfig(opencodeConfig);
          validateMcphubConfig(cfg);

          const retries = args.retries ?? 3;

          const result = await withRetries(
            () =>
              callMcphubTool({ url: cfg.url, headers: cfg.headers }, "search_tools", {
                query: args.query,
                ...(args.limit ? { limit: args.limit } : {})
              }),
            retries
          );

          return args.raw ? JSON.stringify(result, null, 2) : formatCallToolResult(result);
        }
      }),

      mcphub_describe_tool: tool({
        description: "获取 MCPHub 聚合层工具的完整 schema（等价于远程的 describe_tool）",
        args: {
          toolName: tool.schema.string().min(1).describe("Tool name from search_tools"),
          retries: tool.schema.number().int().min(0).max(3).optional().describe("Retry count on timeout"),
          raw: tool.schema.boolean().optional().describe("Return raw MCP result")
        },
        async execute(args) {
          const cfg = pickMcphubConfig(opencodeConfig);
          validateMcphubConfig(cfg);

          const retries = args.retries ?? 3;

          let result;
          try {
            result = await withRetries(
              () =>
                callMcphubTool({ url: cfg.url, headers: cfg.headers }, "describe_tool", {
                  toolName: args.toolName
                }),
              retries
            );
          } catch (err) {
            const fallback = await withRetries(
              () =>
                callMcphubTool({ url: cfg.url, headers: cfg.headers }, "search_tools", {
                  query: args.toolName,
                  limit: 10
                }),
              retries
            );
            return args.raw ? JSON.stringify(fallback, null, 2) : formatCallToolResult(fallback);
          }

          if (args.raw) {
            return JSON.stringify(result, null, 2);
          }

          if (!result?.isError) {
            return formatCallToolResult(result);
          }

          const searchResult = await withRetries(
            () =>
              callMcphubTool({ url: cfg.url, headers: cfg.headers }, "search_tools", {
                query: args.toolName,
                limit: 10
              }),
            retries
          );

          const searchText = formatCallToolResult(searchResult);
          try {
            const parsed = JSON.parse(searchText);
            const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
            const found = tools.find((t) => t && t.name === args.toolName);
            if (found) {
              return JSON.stringify({
                tool: {
                  name: found.name,
                  description: found.description,
                  inputSchema: found.inputSchema,
                  serverName: found.serverName
                },
                metadata: {
                  message: "Fallback schema from search_tools"
                }
              });
            }
          } catch (err) {
            void err;
          }

          return formatCallToolResult(result);
        }
      }),

      mcphub_call_tool: tool({
        description: "调用 MCPHub 聚合层执行工具（等价于远程的 call_tool）",
        args: {
          toolName: tool.schema.string().min(1).describe("Target tool name"),
          arguments: tool.schema.string().optional().describe("JSON string of tool arguments"),
          retries: tool.schema.number().int().min(0).max(3).optional().describe("Retry count on timeout"),
          allowRetryForMutating: tool.schema
            .boolean()
            .optional()
            .describe("Allow retry for mutating tool names"),
          raw: tool.schema.boolean().optional().describe("Return raw MCP result")
        },
        async execute(args) {
          const cfg = pickMcphubConfig(opencodeConfig);
          validateMcphubConfig(cfg);

          const parsed = parseJsonObject(args.arguments, "arguments");

          const requestedRetries = args.retries ?? 3;
          const allowRetryForMutating = args.allowRetryForMutating ?? true;
          const retries =
            isPotentiallyMutatingToolName(args.toolName) && !allowRetryForMutating
              ? 0
              : requestedRetries;

          const result = await withRetries(
            () =>
              callMcphubTool({ url: cfg.url, headers: cfg.headers }, "call_tool", {
                toolName: args.toolName,
                arguments: parsed
              }),
            retries
          );

          return args.raw ? JSON.stringify(result, null, 2) : formatCallToolResult(result);
        }
      })
    }
  };
}
