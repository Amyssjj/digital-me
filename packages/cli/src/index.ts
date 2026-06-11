/**
 * @digital-me/cli
 *
 * Public surface for callers that want to embed the CLI's diagnostics
 * programmatically — `runDoctor` + `formatReport`. The actual `bin/`
 * entry that does fs writes is shipped in `dist/bin/digital-me.js`
 * (see package.json#bin).
 */

export {
  RUNTIME_EXPECTATIONS,
  formatReport,
  runDoctor,
} from "./doctor.js";
export type {
  CheckResult,
  DoctorDeps,
  DoctorReport,
  RuntimeId,
} from "./doctor.js";
