/**
 * First-party Prometheus text-format registry (ADR 0016). In-process
 * counters cover this process's HTTP and ingestion activity; cross-process
 * gauges are supplied by the collector at scrape time from MongoDB/Redis.
 */
export class MetricsRegistry {
  readonly #counters = new Map<string, number>();
  readonly #counterHelp = new Map<string, string>();
  readonly #labelOrders = new Map<string, readonly string[]>();

  public declareCounter(
    name: string,
    help: string,
    labels: readonly string[] = [],
  ): void {
    this.#counterHelp.set(name, help);
    this.#labelOrders.set(name, labels);
  }

  public increment(name: string, labelValues: readonly string[] = [], by = 1): void {
    const key = `${name}|${labelValues.join("|")}`;
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + by);
  }

  /**
   * Render the registry plus caller-supplied gauges in Prometheus text
   * exposition format. Gauges arrive as name/help/value tuples so
   * cross-process truth stays with the collector.
   */
  public render(gauges: readonly GaugeValue[] = []): string {
    const lines: string[] = [];

    for (const [name, help] of this.#counterHelp) {
      const labelNames = this.#labelOrders.get(name) ?? [];
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      const series = [...this.#counters]
        .filter(([key]) => key.startsWith(`${name}|`))
        .map(([key, value]) => {
          const values = key.slice(name.length + 1).split("|");
          const pairs = labelNames.map(
            (label, index) => `${label}="${sanitize(values[index] ?? "")}"`,
          );
          const rendered = pairs.length === 0 ? name : `${name}{${pairs.join(",")}}`;
          return `${rendered} ${value}`;
        });
      lines.push(...(series.length > 0 ? series : emptySeries(name, labelNames)));
    }

    const gaugesByName = new Map<string, GaugeValue[]>();
    for (const gauge of gauges) {
      const group = gaugesByName.get(gauge.name) ?? [];
      group.push(gauge);
      gaugesByName.set(gauge.name, group);
    }
    for (const [name, group] of gaugesByName) {
      lines.push(`# HELP ${name} ${group[0]?.help ?? ""}`);
      lines.push(`# TYPE ${name} gauge`);
      const labelNames = group[0]?.labelNames ?? [];
      for (const gauge of group) {
        const pairs = labelNames.map(
          (label, index) => `${label}="${sanitize(gauge.labelValues[index] ?? "")}"`,
        );
        lines.push(
          pairs.length === 0
            ? `${name} ${gauge.value}`
            : `${name}{${pairs.join(",")}} ${gauge.value}`,
        );
      }
    }

    return `${lines.join("\n")}\n`;
  }
}

export interface GaugeValue {
  readonly name: string;
  readonly help: string;
  readonly value: number;
  readonly labelNames: readonly string[];
  readonly labelValues: readonly string[];
}

function sanitize(value: string): string {
  return value.replace(/"/g, "").replace(/[\r\n]/g, "");
}

function emptySeries(name: string, labels: readonly string[]): string[] {
  const pairs = labels.map((label) => `${label}=""`);
  return [pairs.length === 0 ? `${name} 0` : `${name}{${pairs.join(",")}} 0`];
}

export const httpRequestsTotal = "oscar_http_requests_total";
export const ingestionRequestsTotal = "oscar_ingestion_requests_total";
export const httpRequestDurationMs = "oscar_http_request_duration_ms";

/** Shared api-process registry so every middleware reports into one place. */
export const apiMetrics = new MetricsRegistry();
apiMetrics.declareCounter(
  httpRequestsTotal,
  "HTTP requests by route class and status",
  ["class", "status"],
);
apiMetrics.declareCounter(
  ingestionRequestsTotal,
  "Internal ingestion requests by outcome",
  ["outcome"],
);
apiMetrics.declareCounter(
  httpRequestDurationMs,
  "HTTP request duration accumulations in milliseconds",
  ["class"],
);
