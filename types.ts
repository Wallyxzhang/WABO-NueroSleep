export interface FrequencyBands {
  delta: number;
  theta: number;
  alpha: number;
  beta: number;
  gamma: number;
}

export interface EEGDataPoint {
  timestamp: number;
  value: number; // 原始脑电值 (Raw EEG value)
}

export interface AnalysisMetrics {
  attention: number;
  relaxation: number;
  isMeditating: boolean;
}

export enum AppState {
  IDLE = 'IDLE',
  RUNNING = 'RUNNING',
}

export type Language = 'zh' | 'en';