import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  childTraceContext,
  generateTraceContext,
  parseTraceParent,
  traceParentHeader,
} from "../../../src/infrastructure/observability/trace-context.js";
import { MetricsRegistry } from "../../../src/infrastructure/metrics/registry.js";
import { corsAllowlistMiddleware } from "../../../src/infrastructure/http/security-middleware.js";
import type { Request, Response } from "express";

describe("trace context", () => {
  it("accepts valid traceparents and rejects malformed ones", () => {
    const valid = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    expect(parseTraceParent(valid)).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    });
    expect(parseTraceParent("garbage")).toBeUndefined();
    expect(parseTraceParent(undefined)).toBeUndefined();
    expect(
      parseTraceParent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
    ).toBeUndefined();
    expect(parseTraceParent("00-xyz-00f067aa0ba902b7-01")).toBeUndefined();
  });

  it("generates well-formed contexts and stable children", () => {
    const root = generateTraceContext();
    expect(traceParentHeader(root)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const child = childTraceContext(root);
    expect(child.traceId).toBe(root.traceId);
    expect(child.parentId).not.toBe(root.parentId);
  });
});

describe("metrics registry", () => {
  it("renders declared counters and supplied gauges in text format", () => {
    const registry = new MetricsRegistry();
    registry.declareCounter("x_total", "A counter", ["code"]);
    registry.increment("x_total", ["200"]);
    registry.increment("x_total", ["200"]);
    registry.increment("x_total", ["500"]);
    const body = registry.render([
      {
        name: "gauge_x",
        help: "A gauge",
        value: 7,
        labelNames: ["kind"],
        labelValues: ["a"],
      },
      {
        name: "gauge_plain",
        help: "No labels",
        value: 3,
        labelNames: [],
        labelValues: [],
      },
    ]);
    expect(body).toContain("# TYPE x_total counter");
    expect(body).toContain('x_total{code="200"} 2');
    expect(body).toContain(String.raw`gauge_x{kind="a"} 7`);
    expect(body).toContain("gauge_plain 3");
  });

  it("sanitizes label values against injection", () => {
    const registry = new MetricsRegistry();
    registry.declareCounter("inj_total", "x", ["label"]);
    registry.increment("inj_total", ['bad"label\ninjection']);
    const body = registry.render();
    expect(body).toContain('inj_total{label="badlabelinjection"}');
  });
});

describe("CORS allowlist", () => {
  function harness(origin?: string) {
    const headers: Record<string, string | number> = {};
    let status = 0;
    let ended = false;
    const response = {
      setHeader: (name: string, value: string | number) => {
        headers[name] = value;
      },
      status: (code: number) => {
        status = code;
        return response;
      },
      end: () => {
        ended = true;
      },
    } as unknown as Response;
    const middleware = corsAllowlistMiddleware(["https://merchant.example"]);
    let nexted = false;
    middleware(
      {
        method: "GET",
        headers: origin === undefined ? {} : { origin },
      } as unknown as Request,
      response,
      () => {
        nexted = true;
      },
    );
    return { headers, status, ended, nexted };
  }

  it("reflects allowed origins only", () => {
    const allowed = harness("https://merchant.example");
    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "https://merchant.example",
    );
    expect(allowed.nexted).toBe(true);
    const denied = harness("https://evil.example");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    expect(denied.nexted).toBe(true);
    const none = harness(undefined);
    expect(none.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers allowed preflights without routing", () => {
    const headers: Record<string, string | number> = {};
    let ended = false;
    const response = {
      setHeader: (name: string, value: string | number) => {
        headers[name] = value;
      },
      status: () => response,
      end: () => {
        ended = true;
      },
    } as unknown as Response;
    corsAllowlistMiddleware(["https://merchant.example"])(
      {
        method: "OPTIONS",
        headers: { origin: "https://merchant.example" },
      } as unknown as Request,
      response,
      () => {
        throw new Error("must not route");
      },
    );
    expect(ended).toBe(true);
    expect(String(headers["access-control-allow-headers"])).toContain("authorization");
  });
});

describe("alerting rules reference emitted metrics", () => {
  it("matches every rule expression to the implemented metric set", () => {
    const yaml = readFileSync("docs/alerting/prometheus-rules.yaml", "utf8");
    const expressions = [...yaml.matchAll(/expr: (.+)/g)].map((match) =>
      match[1]?.trim(),
    );
    const alerts = [...yaml.matchAll(/- alert: (\w+)/g)].map((match) => match[1]);
    expect(alerts.length).toBeGreaterThanOrEqual(9);
    expect(expressions).toHaveLength(alerts.length);
    const emitted = [
      "oscar_chain_ready",
      "oscar_token_decimals_ready",
      "oscar_stuck_payments",
      "oscar_reorg_records_total",
      "oscar_payments_by_status",
      "oscar_queue_lag",
      "oscar_webhook_dead_letter",
      "oscar_compliance_holds",
    ];
    for (const expression of expressions) {
      const referenced = emitted.filter((metric) =>
        (expression ?? "").includes(metric),
      );
      // The readiness rule uses the probe job metric; all others use an
      // emitted gateway metric.
      expect(
        referenced.length > 0 || (expression ?? "").includes("probe_success"),
        expression,
      ).toBe(true);
    }
  });
});
