import { randomUUID } from 'node:crypto';
import { db, type Db } from './db.js';

export const activeStatuses = ['QUEUED', 'RUNNING', 'RETRY_PENDING'];
export class PermanentError extends Error {}
export async function enqueue(kind: string, payload: object, dedupeKey: string, client: Db = db, videoId?: string) {
  return client.job.upsert({ where: { dedupeKey }, create: { kind, payload: JSON.stringify(payload), dedupeKey, videoId }, update: {} });
}
export async function enqueueDiscovery(dedupeKey: string, client: Db = db) {
  return client.$transaction(async tx => {
    const active = await tx.job.findFirst({ where: { kind: 'DISCOVER', status: { in: activeStatuses } } });
    return active || tx.job.upsert({ where: { dedupeKey }, create: { kind: 'DISCOVER', payload: '{}', dedupeKey }, update: {} });
  });
}
export async function recoverExpired(client: Db = db, now = new Date()) {
  const expired = await client.job.findMany({ where: { status: 'RUNNING', leaseExpiresAt: { lte: now } } });
  for (const job of expired) {
    const exhausted = job.attempts >= job.maxAttempts;
    await client.$transaction(async tx => {
      const changed = await tx.job.updateMany({ where: { id: job.id, status: 'RUNNING', leaseOwner: job.leaseOwner, leaseExpiresAt: { lte: now } }, data: { status: exhausted ? 'FAILED' : 'RETRY_PENDING', availableAt: now, leaseOwner: null, leaseExpiresAt: null, lastError: 'A execução foi interrompida; o prazo da tarefa expirou.' } });
      if (changed.count) {
        await tx.jobLog.create({ data: { jobId: job.id, level: 'warning', message: exhausted ? 'Tarefa interrompida atingiu o limite de tentativas.' : 'Tarefa interrompida recuperada para nova tentativa.' } });
        if (job.videoId && job.kind !== 'TIKTOK_PUBLISH') await tx.video.update({ where: { id: job.videoId }, data: { state: exhausted ? 'FAILED' : 'RETRY_PENDING', lastError: 'Execução interrompida.' } });
      }
    });
  }
}
export async function claim(client: Db = db, leaseMs = 30000) {
  const now = new Date();
  const candidate = await client.job.findFirst({ where: { status: { in: ['QUEUED', 'RETRY_PENDING'] }, availableAt: { lte: now } }, orderBy: { createdAt: 'asc' } });
  if (!candidate) return null;
  if (candidate.attempts >= candidate.maxAttempts) {
    await client.job.updateMany({ where: { id: candidate.id, status: candidate.status }, data: { status: 'FAILED', lastError: candidate.lastError || 'Limite de tentativas atingido.' } });
    return null;
  }
  const owner = randomUUID();
  const result = await client.job.updateMany({ where: { id: candidate.id, status: candidate.status, attempts: candidate.attempts, availableAt: { lte: now } }, data: { status: 'RUNNING', leaseOwner: owner, leaseExpiresAt: new Date(Date.now() + leaseMs), attempts: { increment: 1 } } });
  return result.count ? client.job.findUniqueOrThrow({ where: { id: candidate.id } }) : null;
}
export async function cancelJob(id: string, client: Db = db) {
  return client.$transaction(async tx => {
    const job = await tx.job.findUniqueOrThrow({ where: { id } });
    const result = await tx.job.updateMany({ where: { id, status: { in: activeStatuses } }, data: { status: 'CANCELED', leaseOwner: null, leaseExpiresAt: null } });
    if (result.count) {
      await tx.jobLog.create({ data: { jobId: id, level: 'warning', message: 'Tarefa cancelada pelo usuário.' } });
      if (job.videoId && job.kind !== 'TIKTOK_PUBLISH') await tx.video.update({ where: { id: job.videoId }, data: { state: 'CANCELED' } });
    }
    return result.count;
  });
}
export async function retryJob(id: string, client: Db = db) {
  return client.$transaction(async tx => {
    const job = await tx.job.findUniqueOrThrow({ where: { id } });
    const result = await tx.job.updateMany({ where: { id, status: { in: ['FAILED', 'CANCELED'] } }, data: { status: 'RETRY_PENDING', attempts: 0, availableAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastError: null } });
    if (result.count) {
      await tx.jobLog.create({ data: { jobId: id, level: 'info', message: 'Nova execução solicitada pelo usuário.' } });
      if (job.videoId && job.kind !== 'TIKTOK_PUBLISH') await tx.video.update({ where: { id: job.videoId }, data: { state: 'RETRY_PENDING', lastError: null } });
    }
    return result.count;
  });
}
type ClaimedJob = NonNullable<Awaited<ReturnType<typeof claim>>>;
export type Handler = (job: ClaimedJob, signal: AbortSignal, log: (message: string) => Promise<void>) => Promise<void>;
export class Worker {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private current?: AbortController;
  private pending?: Promise<void>;
  constructor(private handler: Handler, private client: Db = db) {}
  start() {
    this.timer = setInterval(() => { if (!this.busy) this.pending = this.tick(); }, 1000);
    this.pending = this.tick();
  }
  async stop() {
    clearInterval(this.timer);
    this.current?.abort(new Error('Aplicação encerrando.'));
    await this.pending;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await recoverExpired(this.client);
      const job = await claim(this.client);
      if (!job) return;
      const controller = new AbortController();
      this.current = controller;
      const owned = { id: job.id, status: 'RUNNING', leaseOwner: job.leaseOwner };
      const heartbeat = setInterval(async () => {
        try {
          const alive = await this.client.job.updateMany({ where: owned, data: { leaseExpiresAt: new Date(Date.now() + 30000) } });
          if (!alive.count) controller.abort(new Error('Tarefa cancelada ou retomada por outro worker.'));
        } catch (error) { controller.abort(error); }
      }, 5000);
      const log = async (message: string) => { await this.client.jobLog.create({ data: { jobId: job.id, level: 'info', message } }); };
      try {
        await log(`Iniciando tentativa ${job.attempts} de ${job.maxAttempts}.`);
        await this.handler(job, controller.signal, log);
        controller.signal.throwIfAborted();
        const finished = await this.client.job.updateMany({ where: owned, data: { status: 'COMPLETED', leaseOwner: null, leaseExpiresAt: null, lastError: null } });
        if (finished.count) await log('Etapa concluída e resultado salvo.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const shuttingDown = controller.signal.aborted && controller.signal.reason instanceof Error && controller.signal.reason.message === 'Aplicação encerrando.';
        const retry = shuttingDown || (!(error instanceof PermanentError) && job.attempts < job.maxAttempts);
        await this.client.$transaction(async tx => {
          const result = await tx.job.updateMany({ where: owned, data: { status: retry ? 'RETRY_PENDING' : 'FAILED', availableAt: new Date(Date.now() + (shuttingDown ? 0 : Math.min(60000, 5000 * 2 ** job.attempts))), leaseOwner: null, leaseExpiresAt: null, lastError: message, ...(shuttingDown ? { attempts: { decrement: 1 } } : {}) } });
          if (result.count) {
            await tx.jobLog.create({ data: { jobId: job.id, level: retry ? 'warning' : 'error', message } });
            if (job.videoId && job.kind !== 'TIKTOK_PUBLISH') await tx.video.update({ where: { id: job.videoId }, data: { state: retry ? 'RETRY_PENDING' : 'FAILED', lastError: message } });
          }
        });
      } finally { clearInterval(heartbeat); this.current = undefined; }
    } catch (error) { console.error('Erro no worker:', error instanceof Error ? error.message : error); }
    finally { this.busy = false; }
  }
}
