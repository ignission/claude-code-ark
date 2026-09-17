import type { HostMetrics } from "@ark/shared";
import { ExternalLink } from "lucide-react";
import { clamp } from "./utils";

interface SystemStatusBarProps {
  metrics: HostMetrics | null;
}

const SPARK_H = 14;
const SPARK_SAMPLES = 30;

export function SystemStatusBar({ metrics }: SystemStatusBarProps) {
  const cpu = metrics ? Math.round(metrics.cpuPercent) : null;
  const memTotal = metrics?.memory.totalGB ?? 0;
  const memUsed = metrics?.memory.usedGB ?? 0;
  const mem =
    metrics && memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : null;
  const disk = metrics?.volumes[0]
    ? Math.round(metrics.volumes[0].usedPercent)
    : null;
  const cpuHistory = metrics?.cpuHistory ?? [];

  // Quick Tunnel 等のトークン認証下でも新タブで Bridge にアクセスできるよう
  // 現在の URL の token クエリを引き継ぐ
  const bridgeHref = buildBridgeHref();

  return (
    <a
      href={bridgeHref}
      target="_blank"
      rel="noopener noreferrer"
      title="Bridgeを別タブで開く"
      className="flex items-center gap-5 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground select-none transition-colors hover:bg-accent cursor-pointer"
    >
      <span className="flex items-center gap-2 flex-1 min-w-0">
        <span className="text-muted-foreground shrink-0">CPU</span>
        <Sparkline values={cpuHistory} />
        <span className="tabular-nums shrink-0">
          {cpu !== null ? `${cpu}%` : "--"}
        </span>
      </span>
      <Metric label="MEM" percent={mem} />
      <Metric label="DISK" percent={disk} />
      <ExternalLink
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    </a>
  );
}

function Metric({ label, percent }: { label: string; percent: number | null }) {
  return (
    <span className="flex items-center gap-1.5 shrink-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">
        {percent !== null ? `${percent}%` : "--"}
      </span>
    </span>
  );
}

function buildBridgeHref(): string {
  if (typeof window === "undefined") return "/bridge";
  const token = new URLSearchParams(window.location.search).get("token");
  return token ? `/bridge?token=${encodeURIComponent(token)}` : "/bridge";
}

function Sparkline({ values }: { values: number[] }) {
  const samples =
    values.length >= SPARK_SAMPLES ? values.slice(-SPARK_SAMPLES) : values;
  // viewBox の幅は固定 100 にして、preserveAspectRatio="none" で親幅に伸縮させる
  const points =
    samples.length > 1
      ? samples
          .map((v, i) => {
            const x = (i / (samples.length - 1)) * 100;
            const y = SPARK_H - (clamp(v, 0, 100) / 100) * SPARK_H;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ")
      : "";
  return (
    <svg
      viewBox={`0 0 100 ${SPARK_H}`}
      preserveAspectRatio="none"
      className="flex-1 min-w-0 h-4 text-muted-foreground"
      aria-hidden="true"
    >
      {points ? (
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}
