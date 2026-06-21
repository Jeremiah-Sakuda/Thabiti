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
  seed: number;
  orders: number;
  allEqual: boolean;
  grandTotal: string;
  runs: { order: number; delivered: number; grandTotal: string }[];
}
