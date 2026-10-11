import { createHash } from "node:crypto";

export function maskId(value) {
  if (typeof value !== "string" || !value) return "-";
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

export function createLog(logger) {
  const emit = (level, message) => {
    try {
      const fn = logger && typeof logger[level] === "function" ? logger[level] : null;
      const line = `[glpi-ticket-gate] ${message}`;
      if (fn) fn(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    } catch {
      /* 日志绝不能打断 hook */
    }
  };
  return {
    debug: (message) => emit("debug", message),
    info: (message) => emit("info", message),
    warn: (message) => emit("warn", message),
  };
}