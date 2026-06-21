import { getConfig, type ThabitiConfig } from "./config";

/**
 * Writer/reader Aurora Capacity Unit (ACU) telemetry that drives the demo's
 * Beat 1 (spike) and Beat 4 (collapse + cost-per-run).
 *
 *  - memory backend → a faithful in-process SIMULATION driven by real activity
 *    (events ingested = writer load, aggregations run = reader load), decaying to
 *    near-zero when idle. Labeled `source: "simulated"`.
 *  - aurora backend → real CloudWatch `ServerlessDatabaseCapacity` per instance
 *    when the AWS SDK + instance ids + creds are present (`source: "cloudwatch"`),
 *    otherwise the same activity-driven estimate (`source: "estimated"`).
 *
 * Independent writer/reader scaling over one shared, snapshot-consistent log —
 * and the collapse to ~0 — is the "Best Use of Aurora" story, shown not asserted.
 */

export type AcuSource = "simulated" | "cloudwatch" | "estimated";

export interface AcuSnapshot {
  writerAcu: number;
  readerAcu: number;
  minAcu: number;
  maxAcu: number;
  source: AcuSource;
  /** Integrated ACU-seconds since the last run mark. */
  acuSecondsWriter: number;
  acuSecondsReader: number;
  /** Cost of the run so far: ACU-seconds × published ACU-hour price. */
  costUsd: number;
  acuHourUsd: number;
  runSeconds: number;
  at: number;
}

interface Activity {
  t: number;
  writer: number;
  reader: number;
}

const DECAY_WINDOW_MS = 6000;
const WRITER_SCALE = 1800; // events per window that approaches max ACU
const READER_SCALE = 1200; // aggregation rows per window that approaches max ACU

class ActivityMeter {
  private activity: Activity[] = [];
  private acuSecondsWriter = 0;
  private acuSecondsReader = 0;
  private lastSampleAt = 0;
  private runStartAt = 0;
  private lastWriterAcu = 0;
  private lastReaderAcu = 0;

  recordIngest(n: number): void {
    if (n <= 0) return;
    this.activity.push({ t: Date.now(), writer: n, reader: 0 });
  }

  recordAggregation(rows: number): void {
    this.activity.push({ t: Date.now(), writer: 0, reader: Math.max(1, rows) });
  }

  /** Reset cost integration at the start of a measured run. */
  markRunStart(): void {
    const now = Date.now();
    this.activity = [];
    this.acuSecondsWriter = 0;
    this.acuSecondsReader = 0;
    this.lastSampleAt = now;
    this.runStartAt = now;
    this.lastWriterAcu = 0;
    this.lastReaderAcu = 0;
  }

  simulate(cfg: ThabitiConfig): AcuSnapshot {
    const now = Date.now();
    const cutoff = now - DECAY_WINDOW_MS;
    this.activity = this.activity.filter((a) => a.t >= cutoff);

    let writerWork = 0;
    let readerWork = 0;
    for (const a of this.activity) {
      writerWork += a.writer;
      readerWork += a.reader;
    }

    const { minAcu, maxAcu } = cfg.aurora;
    const writerAcu = saturate(writerWork, WRITER_SCALE, minAcu, maxAcu);
    const readerAcu = saturate(readerWork, READER_SCALE, minAcu, maxAcu);

    if (this.runStartAt === 0) this.runStartAt = now;
    if (this.lastSampleAt !== 0) {
      const dt = (now - this.lastSampleAt) / 1000;
      // Trapezoidal integration for a smoother cost estimate.
      this.acuSecondsWriter += ((writerAcu + this.lastWriterAcu) / 2) * dt;
      this.acuSecondsReader += ((readerAcu + this.lastReaderAcu) / 2) * dt;
    }
    this.lastSampleAt = now;
    this.lastWriterAcu = writerAcu;
    this.lastReaderAcu = readerAcu;

    const acuSeconds = this.acuSecondsWriter + this.acuSecondsReader;
    const costUsd = (acuSeconds / 3600) * cfg.aurora.acuHourUsd;

    return {
      writerAcu,
      readerAcu,
      minAcu,
      maxAcu,
      source: "simulated",
      acuSecondsWriter: round(this.acuSecondsWriter, 4),
      acuSecondsReader: round(this.acuSecondsReader, 4),
      costUsd: round(costUsd, 6),
      acuHourUsd: cfg.aurora.acuHourUsd,
      runSeconds: round((now - this.runStartAt) / 1000, 2),
      at: now,
    };
  }
}

function saturate(work: number, scale: number, min: number, max: number): number {
  const frac = 1 - Math.exp(-work / scale); // 0 (idle) → ~1 (heavy)
  return round(min + (max - min) * frac, 3);
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// Module-level singleton: shared across API routes within a server instance.
const meter = new ActivityMeter();

export function recordIngest(n: number): void {
  meter.recordIngest(n);
}
export function recordAggregation(rows: number): void {
  meter.recordAggregation(rows);
}
export function markRunStart(): void {
  meter.markRunStart();
}

export async function acuSnapshot(cfg: ThabitiConfig = getConfig()): Promise<AcuSnapshot> {
  if (cfg.backend === "aurora") {
    const real = await tryCloudWatch(cfg).catch(() => null);
    if (real) return real;
    const est = meter.simulate(cfg);
    return { ...est, source: "estimated" };
  }
  return meter.simulate(cfg);
}

/**
 * Best-effort real ACU from CloudWatch. Returns null unless the AWS SDK is
 * installed AND both instance ids + region/creds are configured. Keeping it a
 * dynamic import means the memory path never pulls the SDK.
 */
async function tryCloudWatch(cfg: ThabitiConfig): Promise<AcuSnapshot | null> {
  const { writerInstanceId, readerInstanceId, region } = cfg.aurora;
  if (!writerInstanceId || !readerInstanceId) return null;

  // Variable specifier keeps this optional dependency out of the type graph and
  // out of the memory-path bundle. Install @aws-sdk/client-cloudwatch to enable.
  const pkg = "@aws-sdk/client-cloudwatch";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  try {
    mod = await import(/* webpackIgnore: true */ pkg);
  } catch {
    return null; // SDK not installed
  }

  const client = new mod.CloudWatchClient({ region });
  const now = Date.now();
  const latest = async (instanceId: string): Promise<number> => {
    const res = await client.send(
      new mod.GetMetricStatisticsCommand({
        Namespace: "AWS/RDS",
        MetricName: "ServerlessDatabaseCapacity",
        Dimensions: [{ Name: "DBInstanceIdentifier", Value: instanceId }],
        StartTime: new Date(now - 5 * 60_000),
        EndTime: new Date(now),
        Period: 60,
        Statistics: ["Average"],
      }),
    );
    const points: { Timestamp?: Date; Average?: number }[] = (res.Datapoints ?? []).slice();
    points.sort((a, b) => (a.Timestamp?.getTime() ?? 0) - (b.Timestamp?.getTime() ?? 0));
    return points.at(-1)?.Average ?? cfg.aurora.minAcu;
  };

  const [writerAcu, readerAcu] = await Promise.all([latest(writerInstanceId), latest(readerInstanceId)]);
  const base = meter.simulate(cfg); // reuse cost integration scaffold
  return {
    ...base,
    writerAcu: round(writerAcu, 3),
    readerAcu: round(readerAcu, 3),
    source: "cloudwatch",
  };
}
