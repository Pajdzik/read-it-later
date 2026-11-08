export interface AudioStatus {
  enabled: boolean;
  state: 'none' | 'queued' | 'generating' | 'ready' | 'failed';
  episodeId: string | null;
  sourceRevision: string | null;
  characters: number;
  estimatedDurationSeconds: number;
  estimatedCostUsd: number;
  errorCode: string | null;
  suitability: PodcastSuitability | null;
}

export interface PodcastSuitability {
  tier: 'good' | 'mixed' | 'poor';
  reason: string;
  spokenWords: number;
  codeBlocks: number;
  codeSharePercent: number;
}

export interface AudioMessage {
  version: 1;
  episodeId: string;
  chunkIndex: number;
  generation: number;
}

export interface AudioEnv {
  DB: D1Database;
  AUDIO_BUCKET?: R2Bucket;
  AUDIO_QUEUE?: Queue<AudioMessage>;
  ARTICLE_EXTRACTOR?: Fetcher;
  GOOGLE_TTS_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_TTS_PROJECT_ID?: string;
  ARTICLE_AUDIO_ENABLED?: string;
  AUDIO_MONTHLY_BUDGET_USD?: string;
  AUDIO_FREE_CHARACTERS?: string;
}

export class AudioError extends Error {
  submitted = false;
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'AudioError';
  }
}
