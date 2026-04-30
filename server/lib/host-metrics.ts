/**
 * Host Metrics Collector
 *
 * Bridge ダッシュボード用にホストの CPU / Memory / Disk / Network を取得する。
 *
 * 依存ゼロで動かすため Node 標準 (os, fs, child_process) のみを使用。
 * Linux は /proc を直接読み、macOS は os モジュール + sysctl で代替する。
 *
 * 1秒間隔で sample() を呼び出すことを想定し、CPU 使用率は前回スナップショットからの
 * 差分で算出する。履歴は内部リングバッファで保持する。
 */

import { execSync } from "node:child_process";
import { promises as fs, readFileSync, statSync } from "node:fs";
import os from "node:os";
import type { HostMetrics } from "../../shared/types.js";

/** /proc/stat の cpu 行を集計したスナップショット */
interface CpuSnapshot {
  /** 全コア (cpu) と各論理コア (cpu0, cpu1, ...) の (user+nice+sys+irq+softirq, total) */
  cpus: Array<{ active: number; total: number }>;
}

/** /proc/diskstats の集計値 (sectors read+written) */
interface DiskSnapshot {
  sectors: number;
  ms: number; // 計測時刻 ms
}

/** /proc/net/dev の集計値 */
interface NetSnapshot {
  rxBytes: number;
  txBytes: number;
  ms: number;
}

const HISTORY_CPU_SAMPLES = 36; // 60秒分(=1.6秒間隔×36 ≒ 60s)：UI上は単純に直近60秒として扱う
const HISTORY_MEM_SAMPLES = 18; // 10分分(33s間隔×18≒10m)：CPUより低頻度で間引き

export class HostMetricsCollector {
  private prevCpu: CpuSnapshot | null = null;
  private prevDisk: DiskSnapshot | null = null;
  private prevNet: NetSnapshot | null = null;

  private cpuHistory: number[] = [];
  private memHistory: number[] = [];
  private memSampleCount = 0;

  /** 現在のスナップショットを返す。差分計算のため初回呼び出しは CPU 使用率が 0% になる。 */
  async sample(): Promise<HostMetrics> {
    const cpu = readCpuSnapshot();
    const cpuPercent = this.diffCpuPercent(cpu, "all");
    const cores = this.diffCoresPercent(cpu);
    this.prevCpu = cpu;

    const memory = await readMemory();
    const volumes = readVolumes();
    const disk = await readDiskBytesPerSec(this.prevDisk);
    if (disk.snapshot) this.prevDisk = disk.snapshot;
    const net = await readNetBytesPerSec(this.prevNet);
    if (net.snapshot) this.prevNet = net.snapshot;

    // 履歴更新
    this.cpuHistory.push(cpuPercent);
    if (this.cpuHistory.length > HISTORY_CPU_SAMPLES) this.cpuHistory.shift();

    // メモリ履歴は 10分窓を狙って ~33秒に1度だけ追加（1秒ポーリング前提で 33step に1回）
    this.memSampleCount += 1;
    const memPercent =
      memory.totalGB > 0 ? (memory.usedGB / memory.totalGB) * 100 : 0;
    if (this.memSampleCount >= 33) {
      this.memSampleCount = 0;
      this.memHistory.push(memPercent);
      if (this.memHistory.length > HISTORY_MEM_SAMPLES) this.memHistory.shift();
    }

    return {
      cpuPercent,
      loadAvg: os.loadavg() as [number, number, number],
      memory,
      cores,
      volumes,
      network: { txMBs: net.txMBs, rxMBs: net.rxMBs },
      diskIOMBs: disk.ioMBs,
      tempC: readTemperatureC(),
      gpuPercent: null, // GPU は環境依存度が高いため一旦未対応
      cpuHistory: [...this.cpuHistory],
      memHistory: [...this.memHistory],
    };
  }

  private diffCpuPercent(current: CpuSnapshot, _target: "all"): number {
    if (!this.prevCpu || this.prevCpu.cpus.length === 0) return 0;
    const prev = this.prevCpu.cpus[0];
    const cur = current.cpus[0];
    if (!prev || !cur) return 0;
    const dActive = cur.active - prev.active;
    const dTotal = cur.total - prev.total;
    if (dTotal <= 0) return 0;
    return clamp((dActive / dTotal) * 100, 0, 100);
  }

  private diffCoresPercent(current: CpuSnapshot): number[] {
    if (!this.prevCpu) {
      // 初回は 0% を物理コア数分返す
      return current.cpus.slice(1).map(() => 0);
    }
    const result: number[] = [];
    for (let i = 1; i < current.cpus.length; i++) {
      const prev = this.prevCpu.cpus[i];
      const cur = current.cpus[i];
      if (!prev || !cur) {
        result.push(0);
        continue;
      }
      const dActive = cur.active - prev.active;
      const dTotal = cur.total - prev.total;
      result.push(dTotal <= 0 ? 0 : clamp((dActive / dTotal) * 100, 0, 100));
    }
    return result;
  }
}

/**
 * CPU スナップショットを取得する。
 * Linux: /proc/stat
 * 他: os.cpus() の times を集計（差分計算は同様に動く）
 */
function readCpuSnapshot(): CpuSnapshot {
  if (process.platform === "linux") {
    try {
      const text = readFileSyncSafe("/proc/stat");
      if (text) {
        const lines = text.split("\n").filter(line => line.startsWith("cpu"));
        return { cpus: lines.map(parseProcStatLine) };
      }
    } catch {
      // fallthrough
    }
  }

  const cpus = os.cpus();
  const all = aggregateCpus(cpus);
  return {
    cpus: [
      all,
      ...cpus.map(c => ({
        active: c.times.user + c.times.nice + c.times.sys + c.times.irq,
        total:
          c.times.user +
          c.times.nice +
          c.times.sys +
          c.times.idle +
          c.times.irq,
      })),
    ],
  };
}

function parseProcStatLine(line: string): { active: number; total: number } {
  // "cpu  user nice system idle iowait irq softirq steal guest guest_nice"
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const [
    user = 0,
    nice = 0,
    system = 0,
    idle = 0,
    iowait = 0,
    irq = 0,
    softirq = 0,
    steal = 0,
  ] = parts;
  const active = user + nice + system + irq + softirq + steal;
  const total = active + idle + iowait;
  return { active, total };
}

function aggregateCpus(cpus: os.CpuInfo[]): { active: number; total: number } {
  let active = 0;
  let total = 0;
  for (const c of cpus) {
    const a = c.times.user + c.times.nice + c.times.sys + c.times.irq;
    const t = a + c.times.idle;
    active += a;
    total += t;
  }
  return { active, total };
}

async function readMemory(): Promise<HostMetrics["memory"]> {
  if (process.platform === "linux") {
    const text = await readFileAsyncSafe("/proc/meminfo");
    if (text) {
      const m = parseMeminfo(text);
      const totalGB = kbToGB(m.MemTotal);
      const freeGB = kbToGB(m.MemAvailable ?? m.MemFree);
      const cachedGB = kbToGB((m.Cached ?? 0) + (m.Buffers ?? 0));
      const wiredGB = kbToGB((m.Slab ?? 0) + (m.KernelStack ?? 0));
      // App ≒ Active - Cached - Wired を概算（負値は0クランプ）
      const appGB = Math.max(
        0,
        kbToGB(m.Active ?? m.MemTotal - (m.MemFree ?? 0) - (m.Cached ?? 0)) -
          cachedGB -
          wiredGB
      );
      const swapTotal = kbToGB(m.SwapTotal ?? 0);
      const swapFree = kbToGB(m.SwapFree ?? 0);
      const usedGB = Math.max(0, totalGB - freeGB);
      return {
        totalGB,
        usedGB,
        wiredGB,
        appGB,
        cachedGB,
        compressGB: 0,
        freeGB,
        swapGB: Math.max(0, swapTotal - swapFree),
      };
    }
  }
  // Fallback (macOS など): os.totalmem / freemem のみで簡易表示
  const totalGB = bytesToGB(os.totalmem());
  const freeGB = bytesToGB(os.freemem());
  const usedGB = Math.max(0, totalGB - freeGB);
  return {
    totalGB,
    usedGB,
    wiredGB: 0,
    appGB: usedGB,
    cachedGB: 0,
    compressGB: 0,
    freeGB,
    swapGB: 0,
  };
}

function parseMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z()_]+):\s+(\d+)\s*kB$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

function readVolumes(): HostMetrics["volumes"] {
  // df は Linux/macOS で共通。-P で POSIX フォーマット、-k で KB 単位。
  // 対象は / と $HOME とユーザのデータディレクトリ程度に絞る
  try {
    const out = execSync("df -Pk", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 2000,
    });
    const lines = out.split("\n").slice(1).filter(Boolean);
    const seenMounts = new Set<string>();
    const volumes: HostMetrics["volumes"] = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const totalKB = Number(parts[1]);
      const usedKB = Number(parts[2]);
      const mount = parts.slice(5).join(" ");
      // 仮想FSや小容量のマウントは除外
      if (totalKB < 1024 * 1024) continue; // < 1GB は無視
      if (
        mount.startsWith("/snap") ||
        mount.startsWith("/boot") ||
        mount.startsWith("/var/lib/docker") ||
        mount === "/dev" ||
        mount.startsWith("/dev/") || // /dev/shm 等の tmpfs を除外
        mount.startsWith("/run") ||
        mount.startsWith("/sys") ||
        mount.startsWith("/proc")
      ) {
        continue;
      }
      if (seenMounts.has(mount)) continue;
      seenMounts.add(mount);
      const totalGB = totalKB / 1024 / 1024;
      const usedGB = usedKB / 1024 / 1024;
      const usedPercent = totalKB > 0 ? (usedKB / totalKB) * 100 : 0;
      volumes.push({
        name: deriveVolumeName(mount),
        mount,
        usedPercent: clamp(usedPercent, 0, 100),
        totalGB,
        usedGB,
      });
    }
    // 上位3件のみ（容量大きい順）
    volumes.sort((a, b) => b.totalGB - a.totalGB);
    return volumes.slice(0, 3);
  } catch {
    return [];
  }
}

function deriveVolumeName(mount: string): string {
  if (mount === "/") return "Root";
  if (mount === os.homedir()) return "Home";
  const base = mount.split("/").filter(Boolean).pop();
  return base ? base : mount;
}

async function readDiskBytesPerSec(
  prev: DiskSnapshot | null
): Promise<{ ioMBs: number; snapshot: DiskSnapshot | null }> {
  if (process.platform !== "linux") return { ioMBs: 0, snapshot: null };
  const text = await readFileAsyncSafe("/proc/diskstats");
  if (!text) return { ioMBs: 0, snapshot: null };
  let sectors = 0;
  for (const raw of text.split("\n")) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 14) continue;
    const name = parts[2];
    if (!isWholeDiskDevice(name)) continue;
    const readSectors = Number(parts[5]);
    const writeSectors = Number(parts[9]);
    if (Number.isFinite(readSectors)) sectors += readSectors;
    if (Number.isFinite(writeSectors)) sectors += writeSectors;
  }
  const now = Date.now();
  if (!prev) return { ioMBs: 0, snapshot: { sectors, ms: now } };
  const dt = (now - prev.ms) / 1000;
  if (dt <= 0) return { ioMBs: 0, snapshot: { sectors, ms: now } };
  // 1 sector = 512 bytes
  const bytes = (sectors - prev.sectors) * 512;
  const ioMBs = Math.max(0, bytes / 1024 / 1024 / dt);
  return { ioMBs, snapshot: { sectors, ms: now } };
}

/**
 * /proc/diskstats のデバイス名から、集計対象とすべき「ホールデバイス」かを判定する。
 *
 * 単純に「末尾が数字 → パーティション」とすると、`nvme0n1` や `mmcblk0`
 * などのデバイス本体を誤って除外してしまう (これらの数字は識別子の一部)。
 *
 * 含める: sda / sdb / hda / vda / xvda / nvme0n1 / mmcblk0 / md0 / dm-0
 * 除外:   sda1 / nvme0n1p1 / mmcblk0p1 / loop* / ram*
 */
function isWholeDiskDevice(name: string): boolean {
  if (name.startsWith("loop")) return false;
  if (name.startsWith("ram")) return false;
  // SCSI/SATA/IDE/Xen/VirtIO: sda, hdb, vdc, xvda 等。"sda1" 等のパーティションは除外
  if (/^(s|h|v|xv)d[a-z]+$/.test(name)) return true;
  // NVMe: "nvme<ctrl>n<ns>"。partition は "...p<n>"
  if (/^nvme\d+n\d+$/.test(name)) return true;
  // eMMC/SD: "mmcblk<n>"。partition は "...p<n>"
  if (/^mmcblk\d+$/.test(name)) return true;
  // RAID
  if (/^md\d+$/.test(name)) return true;
  // Device mapper (LVM 等)
  if (/^dm-\d+$/.test(name)) return true;
  return false;
}

async function readNetBytesPerSec(
  prev: NetSnapshot | null
): Promise<{ txMBs: number; rxMBs: number; snapshot: NetSnapshot | null }> {
  if (process.platform !== "linux")
    return { txMBs: 0, rxMBs: 0, snapshot: null };
  const text = await readFileAsyncSafe("/proc/net/dev");
  if (!text) return { txMBs: 0, rxMBs: 0, snapshot: null };
  let rx = 0;
  let tx = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = line.match(
      /^([^:\s]+):\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/
    );
    if (!m) continue;
    const iface = m[1];
    if (iface === "lo") continue;
    if (iface.startsWith("docker") || iface.startsWith("br-")) continue;
    rx += Number(m[2]);
    tx += Number(m[3]);
  }
  const now = Date.now();
  if (!prev)
    return {
      txMBs: 0,
      rxMBs: 0,
      snapshot: { rxBytes: rx, txBytes: tx, ms: now },
    };
  const dt = (now - prev.ms) / 1000;
  if (dt <= 0)
    return {
      txMBs: 0,
      rxMBs: 0,
      snapshot: { rxBytes: rx, txBytes: tx, ms: now },
    };
  const rxMBs = Math.max(0, (rx - prev.rxBytes) / 1024 / 1024 / dt);
  const txMBs = Math.max(0, (tx - prev.txBytes) / 1024 / 1024 / dt);
  return { rxMBs, txMBs, snapshot: { rxBytes: rx, txBytes: tx, ms: now } };
}

function readTemperatureC(): number | null {
  if (process.platform !== "linux") return null;
  // hwmon/thermal_zone から最初の有効値を拾う
  try {
    const candidates = [
      "/sys/class/thermal/thermal_zone0/temp",
      "/sys/class/thermal/thermal_zone1/temp",
    ];
    for (const p of candidates) {
      try {
        const stat = statSync(p);
        if (!stat.isFile()) continue;
        const text = readFileSyncSafe(p);
        if (!text) continue;
        const v = Number(text.trim());
        if (Number.isFinite(v) && v > 0) {
          return v / 1000;
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function readFileSyncSafe(p: string): string | null {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

async function readFileAsyncSafe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return null;
  }
}

function kbToGB(kb: number): number {
  return kb / 1024 / 1024;
}

function bytesToGB(b: number): number {
  return b / 1024 / 1024 / 1024;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export const hostMetrics = new HostMetricsCollector();
