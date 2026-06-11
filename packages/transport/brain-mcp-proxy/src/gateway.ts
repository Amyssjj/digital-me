/**
 * Forward a tool call from the stdio MCP server to the openclaw HTTP gateway.
 *
 * Single function (`invokeGatewayTool`) with all I/O dependencies injected:
 *   - fetchFn: lets tests inject a fake fetch
 *   - timeoutMs: lets tests run with short timeouts
 *   - gateway: pre-resolved URL + token
 *
 * Returns an MCP-shaped CallToolResult. Errors (timeout, network, gateway-
 * level failure) are returned as `isError: true` results, never thrown.
 */

export type GatewayEndpoint = {
  readonly url: string;
  readonly token: string;
};

export type CallToolResult = {
  readonly content: ReadonlyArray<{ type: string; text?: string } & Record<string, unknown>>;
  readonly isError?: boolean;
};

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

type GatewayResponse = {
  ok?: boolean;
  result?: {
    content?: ReadonlyArray<Record<string, unknown>>;
    isError?: boolean;
    details?: unknown;
  };
  error?: {
    message?: string;
    [k: string]: unknown;
  };
};

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

function textResult(text: string, isError = false): CallToolResult {
  return isError
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] };
}

export async function invokeGatewayTool(input: {
  toolName: string;
  args: Record<string, unknown>;
  gateway: GatewayEndpoint;
  fetchFn: FetchFn;
  timeoutMs: number;
}): Promise<CallToolResult> {
  const { toolName, args, gateway, fetchFn, timeoutMs } = input;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let data: GatewayResponse;
  try {
    const resp = await fetchFn(gateway.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${gateway.token}`,
      },
      body: JSON.stringify({ tool: toolName, args }),
      signal: ctrl.signal,
    });
    data = (await resp.json()) as GatewayResponse;
  } catch (err) {
    const message = isAbortError(err)
      ? `Gateway call '${toolName}' timed out after ${timeoutMs}ms`
      : `Gateway call '${toolName}' failed: ${errorMessage(err)}`;
    return textResult(message, true);
  } finally {
    clearTimeout(timer);
  }

  if (data.ok === false) {
    let errText: string;
    if (data.error?.message !== undefined && data.error.message !== "") {
      errText = data.error.message;
    } else if (data.error !== undefined) {
      errText = JSON.stringify(data.error);
    } else {
      errText = "Unknown gateway error";
    }
    return textResult(`Error: ${errText}`, true);
  }

  if (data.result && Array.isArray(data.result.content)) {
    const base: CallToolResult = {
      content: data.result.content as CallToolResult["content"],
    };
    if (data.result.isError !== undefined) {
      return { ...base, isError: data.result.isError };
    }
    return base;
  }

  return textResult(JSON.stringify(data.result, null, 2));
}
