/**
 * Minimal stderr logger. stdout belongs to the stdio transport, so nothing may ever be printed there.
 * Never pass credentials or full URLs with query strings to these functions; use `safeUrl`.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

let current: LogLevel = (process.env["CAP_MCP_LOG_LEVEL"] as LogLevel | undefined) ?? "info";

export function setLogLevel(level: LogLevel): void {
  current = level;
}

function emit(level: Exclude<LogLevel, "silent">, msg: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[current]) return;
  const line = `[cap-mcp-bridge] ${new Date().toISOString()} ${level.toUpperCase()} ${msg}`;
  if (meta && Object.keys(meta).length > 0) {
    process.stderr.write(`${line} ${JSON.stringify(meta)}\n`);
  } else {
    process.stderr.write(`${line}\n`);
  }
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};

/** Strip query string and userinfo so filter values and credentials never reach a log line. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url.split("?")[0] ?? url;
  }
}
