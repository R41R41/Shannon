// The body's side of the head's hold-and-resume lab (shannon-ios services/api/tests/minecraftHoldResumeLab.ts, run 44): the parts where the hold
// lives, bundled with the body's own compiler settings (esbuild, this package's tsconfig) and loaded by the head's lab in its own process:
//   npx esbuild backend/scripts/lab/hold-lab-body.ts --bundle --platform=node --format=esm --packages=external \
//     --tsconfig=backend/tsconfig.json --outfile=backend/lab-bundle/hold-lab-body.mjs
export { CommonFcaControlLoop } from '../../src/services/minebot/integration/commonFca/controlLoop.js';
export { Incidents, withIncidentText } from '../../src/services/minebot/utils/incidents.js';
export { SceneSaver, selfNames, regionsAround } from '../../src/services/minebot/utils/sceneSave.js';
