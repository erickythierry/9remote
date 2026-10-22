export type ToolContext = { sessionId?: string | null };
export type ToolArguments = Record<string, unknown>;
export type McpTool = {
  name: string;
  description: string;
  inputSchema: object;
  run(args?: ToolArguments, context?: ToolContext): unknown | Promise<unknown>;
};
export type RpcMessage = {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: { name?: string; arguments?: ToolArguments; protocolVersion?: string };
};
export type TextToolResult = string & { readonly error?: undefined };
