import { randomBytes } from "node:crypto";

const traceparentPattern = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

export interface TraceContext {
  readonly version: string;
  readonly traceId: string;
  readonly parentId: string;
  readonly flags: string;
}

/**
 * First-party W3C trace-context propagation (ADR 0016): accept a valid
 * `traceparent` on ingress, generate one when absent, echo it in responses,
 * propagate it on internal HTTP egress, and carry it through BullMQ job
 * payloads so worker logs share the request's trace id. No OpenTelemetry
 * SDK is embedded; collector export remains an operational choice.
 */
export function parseTraceParent(value: string | undefined): TraceContext | undefined {
  if (typeof value !== "string" || !traceparentPattern.test(value)) return undefined;
  const parts = value.split("-");
  const version = parts[0];
  const traceId = parts[1];
  const parentId = parts[2];
  const flags = parts[3];
  if (
    version === undefined ||
    traceId === undefined ||
    parentId === undefined ||
    flags === undefined
  ) {
    return undefined;
  }
  if (version === "ff") return undefined;
  return { version, traceId, parentId, flags };
}

export function generateTraceContext(): TraceContext {
  return {
    version: "00",
    traceId: randomBytes(16).toString("hex"),
    parentId: randomBytes(8).toString("hex"),
    flags: "01",
  };
}

export function traceParentHeader(context: TraceContext): string {
  return `${context.version}-${context.traceId}-${context.parentId}-${context.flags}`;
}

export function childTraceContext(context: TraceContext): TraceContext {
  return {
    version: context.version,
    traceId: context.traceId,
    parentId: randomBytes(8).toString("hex"),
    flags: context.flags,
  };
}
