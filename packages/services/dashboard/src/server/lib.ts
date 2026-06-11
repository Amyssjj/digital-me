/**
 * @digital-me/dashboard server entry — currently only re-exports the
 * extracted modules. Additional server modules (db, data, brain-client,
 * routes) will be added in subsequent commits of Phase 2.
 */

export {
  buildSystemStatus,
  checkCronJobs,
  checkDbTables,
  checkFile,
  checkSkill,
  computeOverallHealth,
  detectDrift,
  resolveHomePath,
} from "./drift-status.js";

export type {
  CronJobCheck,
  DbTableCheck,
  DriftIssue,
  DriftSeverity,
  FileCheck,
  OverallHealth,
  SkillCheck,
  SkillEntry,
  SkillsConfig,
  SystemStatus,
} from "./drift-status.js";
