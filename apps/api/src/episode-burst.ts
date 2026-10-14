export function afterBurstPublication(batch: { burstTarget: number; burstSuccesses: number; intervalMinutes: number }, now = new Date()) {
  if (!batch.burstTarget) return null;
  const burstSuccesses = batch.burstSuccesses + 1;
  const finished = burstSuccesses >= batch.burstTarget;
  return {
    burstTarget: finished ? 0 : batch.burstTarget,
    burstSuccesses,
    nextPublishAt: finished ? new Date(now.getTime() + batch.intervalMinutes * 60000) : now
  };
}
