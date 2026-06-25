/** Shared API DTO shapes (browser-safe; no Node imports). */

export interface AcuView {
  writerAcu: number;
  readerAcu: number;
  minAcu: number;
  maxAcu: number;
  source: string;
  costUsd: number;
  acuHourUsd: number;
  acuSecondsWriter: number;
  acuSecondsReader: number;
  runSeconds: number;
}

export interface EnrichedWindow {
  windowKey: string;
  customerId: string;
  metric: string;
  windowOpen: number;
  windowClose: number;
  state: "open" | "sealed";
  sealedAt: number | null;
  sealedWatermark: number | null;
  billedTotal: string;
  billedTotalMicros: string;
  eventCount: number;
}

export interface WatermarkView {
  customerId: string;
  metric: string;
  watermark: number;
  latenessGraceMs: number;
}

export interface CorrectionView {
  correctionId: string;
  eventId: string;
  reason: string;
  quantity: string;
  windowKey: string;
  customerId: string;
  metric: string;
  eventTime: number;
  quarantinedAt: number;
}

export interface StateView {
  backend: string;
  config: {
    windowMs: number;
    latenessGraceMs: number;
    region: string;
    acuHourUsd: number;
    minAcu: number;
    maxAcu: number;
  };
  windows: EnrichedWindow[];
  watermarks: WatermarkView[];
  corrections: CorrectionView[];
  acu: AcuView;
}

export interface ReplayView {
  backend: string;
  seed: number;
  orders: number;
  allEqual: boolean;
  grandTotal: string;
  runs: { order: number; delivered: number; grandTotal: string }[];
}

/** "Pull the Tiebreaker" — gauge billed value across every arrival permutation,
 * with the event_id tiebreaker ON (total order) or OFF (diagnostic). */
export interface GaugeBreakerView {
  dropTiebreaker: boolean;
  metric: string;
  /** The two events that share an event_time (the tie at the heart of it). */
  tie: { eventTime: number; events: { eventId: string; quantity: string }[] };
  /** The ORDER BY clause actually used for this run. */
  orderBy: string;
  runs: { order: number; arrival: string[]; value: string }[];
  /** Distinct billed values observed across all permutations. */
  distinct: string[];
  /** True when every permutation produced the same value (locked, not a coin flip). */
  stable: boolean;
}
