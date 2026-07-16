import type { JobPacket, LinearConfig } from '../types';
const { loadConfig } = require('./config');

function truthy(value: unknown): boolean {
  const raw = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function linearGlobalDisabledReason(): string | null {
  if (truthy(process.env.CCP_LINEAR_DISABLED) || truthy(process.env.CCP_DISABLE_LINEAR)) {
    return 'Linear disabled by CCP_LINEAR_DISABLED/CCP_DISABLE_LINEAR';
  }

  const cfg = loadConfig('linear', {}) as LinearConfig & { disabled?: boolean; dispatchEnabled?: boolean; pollingEnabled?: boolean; syncEnabled?: boolean };
  if (cfg.disabled === true) {
    return 'Linear disabled by configs/linear.json disabled=true';
  }
  if (cfg.dispatchEnabled === false && cfg.pollingEnabled === false && cfg.syncEnabled === false) {
    return 'Linear disabled by configs/linear.json dispatchEnabled=false, pollingEnabled=false, and syncEnabled=false';
  }
  return null;
}

function isLinearGloballyDisabled(): boolean {
  return linearGlobalDisabledReason() !== null;
}

function isHermesKanbanPacket(packet?: Partial<JobPacket> | null): boolean {
  if (!packet) return false;
  const source = String(packet.source || '').trim().toLowerCase();
  const transport = String(packet.metadata?.source_transport || '').trim().toLowerCase();
  return source === 'hermes-kanban' || transport === 'hermes-kanban';
}

function linearDisabledReasonForPacket(packet?: Partial<JobPacket> | null): string | null {
  const globalReason = linearGlobalDisabledReason();
  if (globalReason) {
    return globalReason;
  }
  if (isHermesKanbanPacket(packet)) {
    return 'Linear disabled for Hermes Kanban packet';
  }
  return null;
}

module.exports = {
  isLinearGloballyDisabled,
  isHermesKanbanPacket,
  linearDisabledReasonForPacket,
};

export {
  isLinearGloballyDisabled,
  isHermesKanbanPacket,
  linearDisabledReasonForPacket,
};
