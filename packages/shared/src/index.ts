import { z } from 'zod';

export const pipelineStates = ['DISCOVERED', 'RESEARCHED', 'SCRIPTED', 'AUDIO_READY', 'MEDIA_READY', 'SUBTITLES_READY', 'RENDERED', 'REVIEW_PENDING', 'APPROVED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELED', 'RETRY_PENDING'] as const;
export const settingsSchema = z.object({
  mode: z.enum(['manual', 'semiautomatic']).default('semiautomatic'),
  dailyTopics: z.number().int().min(1).max(30).default(5),
  dailyVideos: z.number().int().min(1).max(20).default(3),
  durationSeconds: z.number().int().min(15).max(90).default(40),
  discoveryIntervalMinutes: z.number().int().min(15).max(1440).default(60),
  discoveryEnabled: z.boolean().default(false),
  region: z.literal('BR').default('BR'),
  language: z.literal('pt-BR').default('pt-BR'),
  ollamaModel: z.string().min(1).max(100).default('qwen3:4b'),
  scriptStyle: z.enum(['jornalístico', 'curioso', 'descontraído', 'storytelling', 'gamer']).default('curioso'),
  template: z.enum(['Notícias', 'Viral', 'Curiosidades']).default('Viral'),
  ttsSpeed: z.number().min(0.7).max(1.4).default(1),
  subtitleSize: z.number().int().min(38).max(92).default(64),
  subtitleColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#D1F49E'),
  subtitleMargin: z.number().int().min(220).max(800).default(400),
  mediaProvider: z.enum(['commons', 'graphics']).default('commons'),
  renderEncoder: z.enum(['auto', 'cpu']).default('auto')
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings = settingsSchema.parse({});
export const agentSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  publicationEnabled: z.boolean().default(false),
  loginPaused: z.boolean().default(false),
  browserMode: z.enum(['persistent', 'extension']).default('persistent'),
  accountHandle: z.string().trim().regex(/^@?[A-Za-z0-9_.]{0,24}$/).transform(value => value.replace(/^@/, '')).default(''),
  times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).length(2).refine(value => new Set(value).size === value.length, 'Escolha dois horários diferentes.').default(['12:00', '19:00']),
  timezone: z.literal('America/Sao_Paulo').default('America/Sao_Paulo'),
  prepareHours: z.number().int().min(1).max(24).default(4),
  autoPublishNormal: z.boolean().default(true),
  autoPublishSensitive: z.boolean().default(false),
  continuousHourly: z.boolean().default(false),
  hourlyResumeAt: z.iso.datetime().optional(),
  burstRunId: z.uuid().optional(),
  burstTarget: z.number().int().min(0).max(10).default(0),
  burstSuccesses: z.number().int().min(0).max(10).default(0),
  allowUnverifiedCaption: z.boolean().default(false),
  captionMode: z.enum(['full', 'source']).default('full'),
  topicFocus: z.enum(['general', 'elections']).default('general'),
  extraPublicationDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  extraPublicationTimes: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).max(4).default([]),
  extraPublicationCount: z.number().int().min(0).max(4).default(0),
  hourlyStartAt: z.iso.datetime().optional(),
  hourlyEndAt: z.iso.datetime().optional(),
  hourlyAutoPublishNormal: z.boolean().default(false)
}).refine(value => !value.hourlyStartAt === !value.hourlyEndAt, 'Informe início e fim da agenda por hora.').refine(value => !value.hourlyStartAt || !value.hourlyEndAt || (Date.parse(value.hourlyEndAt) > Date.parse(value.hourlyStartAt) && Date.parse(value.hourlyEndAt) - Date.parse(value.hourlyStartAt) <= 72 * 3600000), 'A agenda por hora precisa durar até 72 horas.');
export type AgentSettings = z.infer<typeof agentSettingsSchema>;
export type AgentSlot = { id: string; slotKey: string; scheduledFor: string; status: string; videoId: string | null; video?: Video | null; lastError: string | null; postUrl: string | null; submissionStartedAt: string | null };
export type AgentStatus = { settings: AgentSettings; slots: AgentSlot[]; extension?: { directory: string; prepared: boolean }; browser: { state: string; account: string | null; detail: string }; };
export const sourceSchema = z.object({
  name: z.string().trim().min(2).max(100),
  url: z.url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol), 'Use uma URL HTTP ou HTTPS.'),
  category: z.string().trim().min(1).max(60).default('Todas'),
  enabled: z.boolean().default(true)
});
export const manualTrendSchema = z.object({
  title: z.string().trim().min(5).max(250),
  url: z.url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol)),
  summary: z.string().trim().min(40).max(12000),
  category: z.string().trim().min(1).max(60).default('Outros'),
  publishedAt: z.iso.datetime(),
  eventDate: z.string().max(100).optional()
});
export const scriptSchema = z.object({
  origin: z.enum(['ollama', 'edited']).default('edited'),
  title: z.string().min(5).max(150),
  hook: z.string().min(5).max(300),
  narration: z.string().min(30).max(4000),
  description: z.string().min(10).max(2500),
  hashtags: z.array(z.string().max(60)).max(12),
  coverText: z.string().min(2).max(100),
  scenes: z.array(z.object({ text: z.string().min(1).max(1000), visualQuery: z.string().min(1).max(120), title: z.string().min(2).max(100).optional(), sourceUrl: z.url().optional(), sourceUrls: z.array(z.url()).optional(), sectionLabel: z.string().min(2).max(40).optional() })).min(1).max(12),
  sourceUrls: z.array(z.url()).min(1),
  claims: z.array(z.object({ text: z.string().min(1).max(500), sourceUrl: z.url(), evidence: z.string().min(10).max(450) })).min(1).max(8),
  risk: z.enum(['normal', 'sensitive']),
  estimatedDurationSeconds: z.number().min(15).max(90)
});
export type Script = z.infer<typeof scriptSchema>;
export type Check = { id: string; name: string; status: 'ok' | 'warning' | 'missing'; detail: string };
export type Trend = {
  id: string; title: string; category: string; summary: string; score: number;
  publishedAt: string | null; discoveredAt: string; eventDate: string | null;
  factors: { recency: number; coverage: number; brazil: number; evidence: number; event: number; growth: number | null; popularity: null };
  sources: { name: string; url: string; publishedAt: string | null; summary: string }[];
  videoId?: string;
};
export type Job = { id: string; kind: string; status: string; attempts: number; maxAttempts: number; lastError: string | null; createdAt: string; updatedAt: string; videoId: string | null; logs?: { level: string; message: string; createdAt: string }[] };
export type MediaAsset = { originUrl: string; author: string; license: string; attribution: string; restrictions: string; acquiredAt: string; path: string; kind: 'commons' | 'source' | 'graphic' };
export type TimedWord = { text: string; start: number; end: number };
export type Artifacts = { revision: string; audio?: { path: string; duration: number; voice: string }; subtitles?: { path: string; wordCount: number; similarity: number; words: TimedWord[] }; media?: { cards: string[]; assets: MediaAsset[]; template: string }; render?: { path: string; coverPath: string; duration: number; encoder: string; width: number; height: number } };
export type Video = { id: string; trendId: string; title: string; state: typeof pipelineStates[number]; script: Script | null; artifacts: Artifacts | null; research?: { kind?: string; sourceVideoIds?: string[] } | null; scriptReviewedAt: string | null; reviewRequired: boolean; lastError: string | null; createdAt: string; updatedAt: string; outputPath: string | null };
export type Source = { id: string; name: string; url: string; category: string; enabled: boolean; lastFetchedAt: string | null; lastError: string | null; itemCount: number };
