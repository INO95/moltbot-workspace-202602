const { enqueueBridgePayload } = require('./bridge_queue');
const healthService = require('./health_service');

function buildHealthBriefing() {
  const now = new Date();
  const dateText = now.toISOString().slice(0, 10);
  const week = healthService.getSummary(undefined, { period: 'week', refDate: now });
  const month = healthService.getSummary(undefined, { period: 'month', refDate: now });
  const recovery = healthService.getRecovery(undefined, now);

  const topRecovery = Object.values(recovery.byArea || {})
    .sort((a, b) => Number(a.recoveryPercent || 0) - Number(b.recoveryPercent || 0))
    .slice(0, 2)
    .map((x) => `${x.label} ${x.recoveryPercent}%`)
    .join(', ');

  const msg = [
    `🏃 건강 브리핑 (${dateText})`,
    `- 주간: 웨이트 ${week.workout.sessions}회 / 러닝 ${week.running.sessions}회 (${week.running.distanceKm}km)`,
    `- 월간: 웨이트 ${month.workout.sessions}회 / 러닝 ${month.running.sessions}회 (${month.running.distanceKm}km)`,
    `- 회복 주의: ${topRecovery || '없음'}`,
    `- 코멘트: ${week.comment}`,
  ].join('\n');

  return msg;
}

function sendToTelegram(message) {
  const payload = {
    taskId: `health-brief-${Date.now()}`,
    command: `[NOTIFY] ${message}`,
    timestamp: new Date().toISOString(),
    status: 'pending',
  };
  enqueueBridgePayload(payload);
  return payload.taskId;
}

function run() {
  const msg = buildHealthBriefing();
  console.log(msg);
  const taskId = sendToTelegram(msg);
  console.log(`queued: ${taskId}`);
}

if (require.main === module) {
  run();
}

module.exports = {
  buildHealthBriefing,
  sendToTelegram,
};
