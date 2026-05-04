/**
 * Bridge Dashboard — 1280x720 1bit Mac OS 風モニタリングUI
 *
 * モック (docs/superpowers の HTML) をそのまま React コンポーネント化したもの。
 * すべてのセクションで `bridge-` prefix の CSS を使う。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BridgeSession,
  BridgeSessionStatus,
  BridgeSnapshot,
  HostMetrics,
} from "../../../../shared/types";
import "./bridge.css";
import { clamp, formatGB } from "./utils";

interface BridgeDashboardProps {
  /** Socket.IO から受信した最新スナップショット (未着なら null) */
  snapshot: BridgeSnapshot | null;
  /** 現在時刻 (秒精度の表示用) */
  now: Date;
}

export function BridgeDashboard({ snapshot, now }: BridgeDashboardProps) {
  return (
    <div className="bridge-root">
      <div className="bridge-stage">
        <MenuBar now={now} />

        <SessionsGridWindow sessions={snapshot?.sessions ?? []} />

        <SystemMonitorWindow metrics={snapshot?.metrics ?? null} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// メニューバー
// ─────────────────────────────────────────────────────────────────

function MenuBar({ now }: { now: Date }) {
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][now.getDay()];
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return (
    <div className="bridge-menubar">
      <span className="apple"></span>
      <span>
        <b>Ark Bridge</b>
      </span>
      <span>File</span>
      <span>Edit</span>
      <span>View</span>
      <span>Sessions</span>
      <span>Special</span>
      <span className="clock">
        {day} {hh}:{mm}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Sessions Grid (Bridge メイン: 全セッションを 1bit セルで並べる)
// ─────────────────────────────────────────────────────────────────

function SessionsGridWindow({ sessions }: { sessions: BridgeSession[] }) {
  const count = sessions.length;
  return (
    <Window
      className="bridge-w-grid"
      title={count > 0 ? `Sessions — ${count}` : "Sessions"}
    >
      {count === 0 ? (
        <EmptyHint text="no active sessions" />
      ) : (
        <div className="bridge-grid-body" data-count={String(count)}>
          {sessions.map(s => (
            <SessionCell key={s.id} session={s} />
          ))}
        </div>
      )}
    </Window>
  );
}

function SessionCell({ session }: { session: BridgeSession }) {
  return (
    <div className="bridge-cell">
      <div className="bridge-cell-titlebar">
        <span className="bridge-cell-title" title={session.name}>
          {session.name}
        </span>
      </div>
      <div className="bridge-cell-head">
        <span className={`bridge-cell-status${statusClass(session.status)}`}>
          {formatStatusBadge(session.status)}
        </span>
        <span className="bridge-cell-elapsed">
          {formatElapsed(session.elapsedMs)}
        </span>
      </div>
      <div className="bridge-cell-body">
        {session.previewText ? (
          session.previewText
        ) : (
          <span className="bridge-cell-empty">— no output —</span>
        )}
      </div>
    </div>
  );
}

function formatStatusBadge(status: BridgeSessionStatus): string {
  if (status === "ERR") return "!! ERR";
  if (status === "AWAITING") return "!! WAIT";
  return status;
}

/**
 * セルの status バッジに付ける CSS クラスを返す。
 * 1bit デザインを破って状態ごとに色付け (CSS 側 .s-<status> で配色)。
 */
function statusClass(status: BridgeSessionStatus): string {
  return ` s-${status.toLowerCase()}`;
}

// ─────────────────────────────────────────────────────────────────
// System Monitor (CPU / Cores / Memory / Storage) — 4カラム
// ─────────────────────────────────────────────────────────────────

function SystemMonitorWindow({ metrics }: { metrics: HostMetrics | null }) {
  return (
    <Window
      className="bridge-w-monitor"
      title={`System Monitor — ${metrics ? `${metrics.cores.length} cores` : "loading"}`}
    >
      <div className="bridge-monitor-body">
        <CpuSection metrics={metrics} />
        <CoresSection metrics={metrics} />
        <MemorySection metrics={metrics} />
        <StorageSection metrics={metrics} />
      </div>
    </Window>
  );
}

function StorageSection({ metrics }: { metrics: HostMetrics | null }) {
  const volumes = metrics?.volumes ?? [];
  // 容量大きい順に host-metrics 側でソート済み。先頭を主ボリュームとして大きく表示する。
  const primary = volumes[0];
  const others = volumes.slice(1);
  const percent = primary ? Math.round(primary.usedPercent) : 0;
  return (
    <div className="bridge-mon-section">
      <div className="bridge-mon-title">
        <span>Storage</span>
        <span className="sub">
          {primary ? primary.name : `${volumes.length} volumes`}
        </span>
      </div>
      {!primary ? (
        <EmptyHint text="no volumes" />
      ) : (
        <>
          <div className="bridge-storage-pie-wrap">
            <div
              className="bridge-storage-pie"
              style={{
                background: `conic-gradient(#000 0 ${primary.usedPercent}%, #fff ${primary.usedPercent}% 100%)`,
              }}
            />
          </div>
          <div className="bridge-gauge-readout">{percent} %</div>
          <div className="bridge-gauge-label">
            {formatGB(primary.usedGB)} / {formatGB(primary.totalGB)}
          </div>
          {others.length > 0 ? (
            <div className="bridge-storage-others">+ {others.length} more</div>
          ) : null}
        </>
      )}
    </div>
  );
}

function CpuSection({ metrics }: { metrics: HostMetrics | null }) {
  // 異常値 (NaN / Infinity / 範囲外 / undefined) を 1 箇所で 0..100 に正規化し、
  // 針 (補間値) と数値表示 (実測値) の両方で共有する。針の hook 内でも同じ
  // 防御を入れているが、call site でも揃えることで `NaN %` / `140 %` といった
  // 表示が出ない契約を局所で読める形にする。
  const rawTargetPercent = metrics?.cpuPercent;
  const targetPercent =
    typeof rawTargetPercent === "number" && Number.isFinite(rawTargetPercent)
      ? clamp(rawTargetPercent, 0, 100)
      : 0;
  const loadAvg = metrics?.loadAvg ?? [0, 0, 0];
  // 針位置はサーバー値の 1s 離散→滑らかに補間する。上昇はタコメーター風
  // (軽オーバーシュート)、下降はゆっくり吸い付くように降りる非対称挙動。
  // 数値表示は実測値をそのまま出すため targetPercent をそのまま使う
  // (補間値を表示すると上昇オーバーシュート時に実測より大きい % が見えてしまう)。
  const needlePercent = useGaugeNeedleValue(targetPercent);
  // 0%→-90deg、100%→+90deg
  const angle = -90 + (clamp(needlePercent, 0, 100) / 100) * 180;
  return (
    <div className="bridge-mon-section">
      <div className="bridge-mon-title">
        <span>CPU</span>
        <span className="sub">
          {metrics ? `${metrics.cores.length} cores` : "—"}
        </span>
      </div>
      <div className="bridge-gauge">
        <svg viewBox="0 0 200 110" preserveAspectRatio="xMidYMid meet">
          <title>CPU usage gauge</title>
          {/* outer arc */}
          <path
            d="M 10 100 A 90 90 0 0 1 190 100"
            fill="none"
            stroke="#000"
            strokeWidth="1.5"
          />
          {/* tick marks */}
          <g stroke="#000" strokeWidth="1">
            <line x1="10" y1="100" x2="18" y2="100" />
            <line x1="22" y1="63" x2="29" y2="68" />
            <line x1="51" y1="32" x2="56" y2="39" />
            <line x1="100" y1="14" x2="100" y2="22" />
            <line x1="149" y1="32" x2="144" y2="39" />
            <line x1="178" y1="63" x2="171" y2="68" />
            <line x1="190" y1="100" x2="182" y2="100" />
          </g>
          <g stroke="#000" strokeWidth="0.5">
            <line x1="14" y1="80" x2="20" y2="82" />
            <line x1="34" y1="48" x2="40" y2="52" />
            <line x1="73" y1="20" x2="76" y2="27" />
            <line x1="127" y1="20" x2="124" y2="27" />
            <line x1="166" y1="48" x2="160" y2="52" />
            <line x1="186" y1="80" x2="180" y2="82" />
          </g>
          <g
            fontFamily="Chicago, Charcoal, sans-serif"
            fontSize="9"
            textAnchor="middle"
          >
            <text x="10" y="112">
              0
            </text>
            <text x="100" y="9">
              50
            </text>
            <text x="190" y="112">
              100
            </text>
          </g>
          {/* needle */}
          <g transform={`rotate(${angle} 100 100)`}>
            <line
              x1="100"
              y1="100"
              x2="100"
              y2="22"
              stroke="#000"
              strokeWidth="2"
            />
            <polygon points="96,30 100,18 104,30" fill="#000" />
          </g>
          <circle
            cx="100"
            cy="100"
            r="5"
            fill="#fff"
            stroke="#000"
            strokeWidth="1.5"
          />
          <circle cx="100" cy="100" r="1.5" fill="#000" />
        </svg>
      </div>
      <div className="bridge-gauge-readout">{Math.round(targetPercent)} %</div>
      <div className="bridge-gauge-label">
        load avg {loadAvg[0].toFixed(2)} · {loadAvg[1].toFixed(2)} ·{" "}
        {loadAvg[2].toFixed(2)}
      </div>
    </div>
  );
}

function CoresSection({ metrics }: { metrics: HostMetrics | null }) {
  const cores = metrics?.cores ?? [];
  // 表示は最大12コアまで
  const displayed = cores.slice(0, 12);
  // 履歴は最大36サンプル前提で 0-100 → 0-100% の高さに
  const history = metrics?.cpuHistory ?? [];
  return (
    <div className="bridge-mon-section">
      <div className="bridge-mon-title">
        <span>Cores</span>
        <span className="sub">{cores.length} total</span>
      </div>
      <div className="bridge-core-grid">
        {displayed.length === 0
          ? Array.from({ length: 4 }).map((_, i) => (
              <CoreRow key={`p-${i}`} label={`P${i}`} percent={0} />
            ))
          : displayed.map((p, i) => (
              <CoreRow
                key={`c-${i}`}
                label={i < 8 ? `P${i}` : `E${i - 8}`}
                percent={p}
                dense={i >= 8}
              />
            ))}
      </div>
      <div className="bridge-strip">
        {(history.length > 0
          ? history
          : Array.from({ length: 36 }).fill(0)
        ).map((h, i) => (
          <div
            key={`s-${i}`}
            className="s"
            style={{ height: `${clamp(h as number, 0, 100)}%` }}
          />
        ))}
      </div>
      <div className="bridge-strip-axis">
        <span>−60s</span>
        <span>now</span>
      </div>
    </div>
  );
}

function CoreRow({
  label,
  percent,
  dense,
}: {
  label: string;
  percent: number;
  dense?: boolean;
}) {
  const p = clamp(percent, 0, 100);
  return (
    <div className="bridge-core-row">
      <span className="lbl">{label}</span>
      <div className="bridge-core-bar">
        <div className={dense ? "dense" : ""} style={{ width: `${p}%` }} />
      </div>
      <span className="v">{Math.round(p)}%</span>
    </div>
  );
}

function MemorySection({ metrics }: { metrics: HostMetrics | null }) {
  const mem = metrics?.memory;
  const segments = useMemo(() => {
    if (!mem || mem.totalGB <= 0) {
      return [
        { kind: "solid" as const, percent: 0, label: "Wired", value: 0 },
        { kind: "dense" as const, percent: 0, label: "App", value: 0 },
        { kind: "sparse" as const, percent: 0, label: "Cached", value: 0 },
        { kind: "blank" as const, percent: 0, label: "Free", value: 0 },
      ];
    }
    const total = mem.totalGB;
    const wiredPct = (mem.wiredGB / total) * 100;
    const appPct = (mem.appGB / total) * 100;
    const cachedPct = (mem.cachedGB / total) * 100;
    const compressPct = (mem.compressGB / total) * 100;
    const freePct = (mem.freeGB / total) * 100;
    return [
      {
        kind: "solid" as const,
        percent: wiredPct,
        label: "Wired",
        value: mem.wiredGB,
      },
      {
        kind: "dense" as const,
        percent: appPct,
        label: "App",
        value: mem.appGB,
      },
      {
        kind: "sparse" as const,
        percent: cachedPct,
        label: "Cached",
        value: mem.cachedGB,
      },
      {
        kind: "sparse" as const,
        percent: compressPct,
        label: "Compress",
        value: mem.compressGB,
      },
      {
        kind: "blank" as const,
        percent: freePct,
        label: "Free",
        value: mem.freeGB,
      },
    ];
  }, [mem]);

  const memHistory = metrics?.memHistory ?? [];

  return (
    <div className="bridge-mon-section">
      <div className="bridge-mon-title">
        <span>Memory</span>
        <span className="sub">
          {mem
            ? `${mem.usedGB.toFixed(1)} / ${mem.totalGB.toFixed(0)} GB`
            : "—"}
        </span>
      </div>
      <div className="bridge-mem-segments">
        {segments.map((s, i) => (
          <div
            key={`seg-${i}`}
            className={`bridge-mem-seg${s.kind === "blank" ? "" : ` ${s.kind}`}`}
            style={{ width: `${clamp(s.percent, 0, 100)}%` }}
          />
        ))}
      </div>
      <div className="bridge-mem-legend">
        {segments.map((s, i) => (
          <div key={`lg-${i}`} className="bridge-mem-legend-row">
            <span
              className={`bridge-legend-swatch${
                s.kind === "blank" ? "" : ` ${s.kind}`
              }`}
            />
            <span>{s.label}</span>
            <span className="v">{s.value.toFixed(1)}</span>
          </div>
        ))}
        <div className="bridge-mem-legend-row">
          <span />
          <span>Swap</span>
          <span className="v">{mem ? `${mem.swapGB.toFixed(1)} GB` : "—"}</span>
        </div>
      </div>
      <div className="bridge-strip" style={{ marginTop: "auto" }}>
        {(memHistory.length > 0
          ? memHistory
          : Array.from({ length: 18 }).fill(0)
        ).map((h, i) => (
          <div
            key={`m-${i}`}
            className="s"
            style={{ height: `${clamp(h as number, 0, 100)}%` }}
          />
        ))}
      </div>
      <div className="bridge-strip-axis">
        <span>−10m</span>
        <span>now</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// 共通
// ─────────────────────────────────────────────────────────────────

function Window({
  className,
  title,
  children,
}: {
  className: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`bridge-window ${className}`}>
      <div className="bridge-titlebar">
        <span className="bridge-close-box" />
        <span className="bridge-title-text">{title}</span>
        <span className="bridge-zoom-box" />
      </div>
      <div className="bridge-window-body">{children}</div>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        fontSize: 11,
        fontStyle: "italic",
        opacity: 0.7,
      }}
    >
      {text}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * ゲージ針が target に追従するときの値を返す。上昇 / 下降で減衰特性を変えた
 * バネ - ダンパー挙動。
 *
 * - 上昇時: 弱めの減衰 (比 0.61) で軽くオーバーシュートしてすぐ落ち着くタコ
 *   メーター風
 * - 下降時: 強めの減衰 + 弱いバネ (比 0.82) で overshoot をほぼ消し、ゆっくり
 *   target に吸い付くように降りる
 *
 * 入力はサーバー由来の数値なので NaN / Infinity / 範囲外値が来ても内部状態
 * と表示が壊れないよう入口で有限数 + 0..100 に正規化し、収束後は rAF を停止
 * して常時実行コストを抱え込まない。
 */
function useGaugeNeedleValue(rawTarget: number): number {
  // ゲージのドメインは 0..100。NaN / Infinity / 範囲外値が来ても
  // 内部状態と表示が壊れないよう入口で正規化する。
  const target = Number.isFinite(rawTarget) ? clamp(rawTarget, 0, 100) : 0;
  const [displayed, setDisplayed] = useState(target);
  const positionRef = useRef(target);
  const velocityRef = useRef(0);
  // 直近の target 変化方向。次の変化が来るまでこのモードで物理を回す。
  const modeRef = useRef<"up" | "down">("up");
  const lastTargetRef = useRef(target);

  useEffect(() => {
    const prev = lastTargetRef.current;
    if (target < prev) modeRef.current = "down";
    else if (target > prev) modeRef.current = "up";
    lastTargetRef.current = target;

    if (
      Math.abs(positionRef.current - target) < 0.02 &&
      Math.abs(velocityRef.current) < 0.02
    ) {
      return;
    }

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // タブ復帰時の巨大 dt で暴れないようクランプ (~50ms)
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const x = positionRef.current;

      // どちらのモードでもバネ - ダンパー。減衰比でキャラクターを変える:
      //   上昇: 比 0.61 で軽くオーバーシュートするタコメーター挙動
      //   下降: 比 0.82 でほぼ overshoot 無し、ゆっくり target に吸い付く
      //         (一定速度の線形だと小さな drop が「ピタッ」と一瞬で動いて
      //          デジタル感が出るため、バネで微かな間を入れる)
      const isDown = modeRef.current === "down";
      const stiffness = isDown ? 30 : 80;
      const damping = isDown ? 9 : 11;
      const v = velocityRef.current;
      const a = stiffness * (target - x) - damping * v;
      velocityRef.current = v + a * dt;
      positionRef.current = x + velocityRef.current * dt;

      // 収束したらスナップして rAF を停止 (次の target 変化で再開)
      if (
        Math.abs(target - positionRef.current) < 0.02 &&
        Math.abs(velocityRef.current) < 0.02
      ) {
        positionRef.current = target;
        velocityRef.current = 0;
        setDisplayed(target);
        return;
      }
      setDisplayed(positionRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return displayed;
}
