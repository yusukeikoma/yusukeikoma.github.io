---
title: "Integrating MCP into a Go AI Agent Platform"
date: 2026-06-24T12:00:00+09:00
draft: false
tags: ["ai agent", "mcp", "go", "software architecture"]
summary: "How I wired the Model Context Protocol into the Go AI agent platform I described in my previous post — what changed, what stayed the same, and the practical pitfalls along the way."
math: false
---

# Integrating MCP into a Go AI Agent Platform

In my [previous post](../ai-agent-clean-architecture), I described how I rebuilt an AI agent platform in Go around Clean Architecture — separating the model, memory, tool, and streaming concerns behind interfaces so each one could evolve independently.

At the end of that post, I listed MCP integration as a future extension:

> Because tools are already abstracted, an MCP-backed tool layer can be integrated by implementing MCP-aware tools or synchronizing remote tool definitions into the registry.

I have since built that out. This post covers what MCP actually is, how it fits into the tool abstraction I already had, what I had to change, and the practical problems I ran into.

## What MCP is and why it matters

The Model Context Protocol (MCP) is an open protocol, originally introduced by Anthropic, that defines a standard way for AI models and agents to discover and call external tools through a client-server interface.

The core idea is simple: instead of hardcoding tools directly into an agent, you run separate MCP servers that expose their own capability lists. The agent connects to those servers, fetches the tool definitions at runtime, and executes tools by sending protocol messages back to the servers.

This has a few practical implications:

- **Tool discovery is dynamic.** You do not need to recompile or redeploy the agent to add new capabilities. You start a new MCP server and the agent picks it up.
- **Tools are decoupled from the agent runtime.** An MCP server is a separate process. It can be written in Python, TypeScript, Rust, or any language. The agent just speaks JSON over stdio or HTTP.
- **Ecosystem tools become available immediately.** A growing number of services publish official MCP servers — databases, file systems, calendars, web search, code execution, and more. Integrating any of these becomes wiring, not implementation.

From an architecture standpoint, MCP turns tools from a compile-time dependency into a runtime configuration.

## The existing tool abstraction

Before adding MCP, my tool abstraction looked like this:

```go
// pkg/ai/tools/tool.go
type Tool interface {
    Name() string
    Description() string
    JSONSchema() map[string]any
    Call(ctx context.Context, args json.RawMessage) (any, error)
}

type ToolRegistry interface {
    Register(tool Tool) error
    Get(name string) (Tool, error)
    List() []Tool
    Execute(ctx context.Context, name string, args json.RawMessage) (any, error)
}
```

The agent depends only on these interfaces. When a model returns a tool call, the agent calls `registry.Execute(ctx, name, args)` and feeds the result back into the message history. It has no idea whether the tool is a local function, a database query, or a remote service.

The question was: how do I make MCP tools satisfy the `Tool` interface without changing the agent itself?

## The MCP client layer

MCP defines a transport-level protocol. The two most common transports are:

- **stdio**: the agent spawns a subprocess and communicates over stdin/stdout
- **HTTP + SSE**: the agent connects to a remote server over HTTP with server-sent events for streaming

I implemented an MCP client that supports both. The client's job is purely mechanical:

1. Connect to a server
2. Fetch the tool list (`tools/list` request)
3. Execute a specific tool by name and arguments (`tools/call` request)
4. Parse the response

```go
// pkg/ai/mcp/client.go
type Client interface {
    Connect(ctx context.Context) error
    ListTools(ctx context.Context) ([]ToolDefinition, error)
    CallTool(ctx context.Context, name string, args json.RawMessage) (*CallResult, error)
    Close() error
}

type ToolDefinition struct {
    Name        string
    Description string
    InputSchema json.RawMessage
}

type CallResult struct {
    Content []ContentBlock
    IsError bool
}
```

The client is not an agent-level concern. It lives in `pkg/ai/mcp` and knows only about the MCP protocol.

## Wrapping MCP tools into the Tool interface

The key step was making an MCP tool look like any other tool to the agent.

I wrote a thin adapter:

```go
// pkg/ai/mcp/tool_adapter.go
type mcpToolAdapter struct {
    client Client
    def    ToolDefinition
    schema map[string]any
}

func NewToolAdapter(client Client, def ToolDefinition) (tools.Tool, error) {
    var schema map[string]any
    if err := json.Unmarshal(def.InputSchema, &schema); err != nil {
        return nil, fmt.Errorf("parsing tool schema for %s: %w", def.Name, err)
    }
    return &mcpToolAdapter{client: client, def: def, schema: schema}, nil
}

func (t *mcpToolAdapter) Name() string              { return t.def.Name }
func (t *mcpToolAdapter) Description() string       { return t.def.Description }
func (t *mcpToolAdapter) JSONSchema() map[string]any { return t.schema }

func (t *mcpToolAdapter) Call(ctx context.Context, args json.RawMessage) (any, error) {
    result, err := t.client.CallTool(ctx, t.def.Name, args)
    if err != nil {
        return nil, err
    }
    if result.IsError {
        return nil, fmt.Errorf("tool %s returned error: %v", t.def.Name, result.Content)
    }
    return result.Content, nil
}
```

From the agent's perspective, an MCP tool is just a `Tool`. The adapter handles all the protocol-level details.

## Loading MCP tools at startup

The infrastructure layer is responsible for connecting to MCP servers and registering their tools.

I introduced an `MCPServerConfig` type:

```go
type MCPServerConfig struct {
    Name      string
    Transport string // "stdio" or "http"
    Command   string // for stdio: executable path
    Args      []string
    URL       string // for http: server URL
}
```

And a loader that takes a list of server configs, connects to each one, fetches their tools, and wraps them:

```go
// infra/ai/mcp/loader.go
func LoadFromServers(
    ctx context.Context,
    servers []MCPServerConfig,
    registry tools.ToolRegistry,
) error {
    for _, cfg := range servers {
        client, err := newClient(cfg)
        if err != nil {
            return fmt.Errorf("creating client for %s: %w", cfg.Name, err)
        }
        if err := client.Connect(ctx); err != nil {
            return fmt.Errorf("connecting to %s: %w", cfg.Name, err)
        }
        defs, err := client.ListTools(ctx)
        if err != nil {
            return fmt.Errorf("listing tools from %s: %w", cfg.Name, err)
        }
        for _, def := range defs {
            adapter, err := mcp.NewToolAdapter(client, def)
            if err != nil {
                return fmt.Errorf("creating adapter for %s/%s: %w", cfg.Name, def.Name, err)
            }
            if err := registry.Register(adapter); err != nil {
                return fmt.Errorf("registering %s/%s: %w", cfg.Name, def.Name, err)
            }
        }
    }
    return nil
}
```

The use case then calls `LoadFromServers` during setup, before constructing and running the agent. The agent itself does not know this happened.

## What the use case looks like

Before MCP, the use case set up tools explicitly:

```go
func (uc *AgentRunUsecase) Run(ctx context.Context, req RunRequest) error {
    registry := tools.NewRegistry()
    registry.Register(NewSearchTool(uc.searchRepo))
    registry.Register(NewSummarizeTool())

    agent := agents.NewReactAgent(model, memory, registry, writer)
    return agent.Run(ctx, req.Input)
}
```

After adding MCP support, the use case can also load dynamic tools from configured servers:

```go
func (uc *AgentRunUsecase) Run(ctx context.Context, req RunRequest) error {
    registry := tools.NewRegistry()
    registry.Register(NewSearchTool(uc.searchRepo))

    if len(uc.mcpServers) > 0 {
        if err := mcp.LoadFromServers(ctx, uc.mcpServers, registry); err != nil {
            return fmt.Errorf("loading mcp tools: %w", err)
        }
    }

    agent := agents.NewReactAgent(model, memory, registry, writer)
    return agent.Run(ctx, req.Input)
}
```

The agent still depends only on `ToolRegistry`. The fact that some tools came from MCP servers is invisible to it.

## Problems I ran into

### 1. Tool name collisions

When you register tools from multiple MCP servers, name collisions become possible. Two servers might both expose a tool named `search` or `get_file`.

I initially handled this by prefixing tool names with the server name:

```go
prefixedName := cfg.Name + "__" + def.Name
```

That solves the collision, but it means the agent must use names like `filesystem__read_file` in its tool calls, which the model has to learn from the schema descriptions.

I later changed the default behavior: if a tool name is unique across all servers, register it without the prefix. Only add the prefix when there is an actual collision. This keeps tool names clean in the common case.

### 2. Slow startup when MCP servers take time to initialize

With stdio transport, the MCP server is a subprocess. Some servers take a second or two to start up, especially if they are written in Python and have a large import footprint.

This is fine in a development loop, but in production it can delay the first agent request significantly if tools are loaded lazily on first use.

I moved tool loading to application startup instead of per-request, and cached the connected clients. That introduced its own problem: clients can crash or disconnect, so the infrastructure layer now also handles reconnection.

### 3. Schema shape mismatches

MCP uses JSON Schema for tool input definitions, but different MCP server authors interpret JSON Schema differently. Some use `object` with `properties`. Some nest `oneOf` in unusual ways. Some omit `required` entirely.

Because I convert the raw JSON Schema into a `map[string]any` and pass it directly to the model, some tool definitions confuse the model into calling the tool with wrong argument types.

For built-in tools, I own the schema and can guarantee a clean shape. For MCP tools, I added a normalization step that:

- ensures the top-level type is `object`
- ensures `properties` exists
- strips schema keywords that specific providers handle poorly (such as deeply nested `$defs` references)

This is not ideal. But it is pragmatic. MCP's schema handling will likely become more standardized over time.

### 4. Error handling is noisier

When a hardcoded tool fails, the error is local Go code. The stack trace is clear.

When an MCP tool fails, the error might come from:

- a network transport failure
- a subprocess that exited unexpectedly
- a server-side error encoded inside a `CallResult` with `IsError: true`
- a JSON parse error on the response

These all need to be surfaced differently for debugging. I added structured error types that carry the server name and tool name so log lines are actionable:

```go
type MCPCallError struct {
    ServerName string
    ToolName   string
    Cause      error
    IsRemote   bool // true if the error originated server-side
}
```

This sounds like overhead, but when you have five MCP servers and a tool call fails during a production run, knowing immediately which server returned the error is worth the extra type.

## What the overall structure looks like now

The layer breakdown has not fundamentally changed from the original architecture:

```text
pkg/ai/
  agents/     // ReactAgent — unchanged
  memory/     // Memory abstraction — unchanged
  models/     // Model abstraction — unchanged
  tools/      // Tool / ToolRegistry abstractions — unchanged
  mcp/        // MCP Client, ToolAdapter, error types — new

infra/
  ai/mcp/     // stdio client, http client, loader — new
  ai/tools/   // default registry implementation — unchanged

application/
  usecases/   // AgentRunUsecase — small addition to load MCP tools
```

The agent layer itself required zero changes. All the new code lives in `pkg/ai/mcp` and `infra/ai/mcp`.

That was the goal of the original design. MCP integration became a matter of adding a new adapter and a loader, without touching the core execution logic.

## What works well

The adapter pattern holds up cleanly.

Because `Tool` is an interface with four methods, wrapping an MCP call behind it is straightforward. The agent loop — load history, call model, execute tools, accumulate stream — does not know or care whether a given tool is local or remote.

This also means the test setup is unchanged. Agent tests can still inject a mock `ToolRegistry` and exercise the execution logic without running any MCP servers.

## What I would change in hindsight

**Per-server connection pooling.** Currently each use-case run that loads MCP tools either hits the cache or blocks on connection. A more robust approach would be a connection pool per server, with health checks and reconnection managed separately from request handling.

**Tool versioning.** MCP servers can update their tool definitions between deployments. Right now, I fetch the tool list at startup and do not refresh it until the application restarts. For long-running processes, it would be useful to periodically re-fetch the definitions and update the registry without downtime.

**Configuration-driven server setup.** Right now, `MCPServerConfig` values are assembled in Go code. Moving them to a YAML configuration file or environment variables would make it easier to add or remove MCP servers without changing application code.

## Conclusion

Adding MCP support to this platform was less disruptive than I expected.

The work was roughly:

- implement an MCP client for stdio and HTTP
- write an adapter that satisfies the `Tool` interface
- write a loader that connects to configured servers and populates the registry

The agent core did not change. The abstractions introduced earlier absorbed the extension without leakage.

MCP is still evolving. The ecosystem is growing quickly, and there are real rough edges around schema handling and server lifecycle management. But the protocol is stable enough to build on, and the ecosystem benefit — being able to integrate any MCP-compatible service without writing a custom tool — is already significant.

For anyone already maintaining a Go-based agent platform, this is a practical and low-risk extension to add.
