import { isIP } from "node:net";
import { APPROVED_MCP_ENDPOINTS } from "./contract.ts";

const TERMINAL_ROOT_DOTS = /\.+$/u;

function isApprovedMcpEndpoint(identifier: string, value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const rawHostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const normalizedHostname = rawHostname.replace(TERMINAL_ROOT_DOTS, "");
  if (
    rawHostname !== normalizedHostname ||
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    parsed.search !== "" ||
    isRejectedNetworkHost(normalizedHostname)
  ) {
    return false;
  }
  return APPROVED_MCP_ENDPOINTS.some(
    (endpoint) => endpoint.value === identifier && endpoint.url === parsed.href,
  );
}

function isRejectedNetworkHost(normalized: string): boolean {
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    !normalized.includes(".") ||
    isIP(normalized) !== 0 ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  ) {
    return true;
  }
  return false;
}

export { isApprovedMcpEndpoint };
