// The public installer API; the work lives in ./install/.
export {
  ASSUMED_TIERS, PRESETS, completeConfig, configProblem, loadPreset, moduleFiles, wantsAuto, wantsCore,
} from './install/plan.mjs';
export { install, syncConfig, uninstall, writeManaged, writeRuntimeSnapshot } from './install/write.mjs';
export { upgrade } from './install/upgrade.mjs';
