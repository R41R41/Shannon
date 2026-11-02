// The body parts S4's isolated head + body rig loads (shannon-ios services/api/scripts/minecraft-rig.ts, scripts/minecraft-trials/rig.py): the real control loop, the real
// native body and the probe bot the lab probes use (the reflexes, the movements), bundled with the body's own compiler settings and loaded by the head's process:
//   npx esbuild backend/scripts/lab/rig-body.ts --bundle --platform=node --format=esm --packages=external \
//     --tsconfig=backend/tsconfig.json --outfile=backend/lab-bundle/rig-body.mjs
// The bundle must stay inside the body tree (its packages are resolved from there).
export { CommonFcaControlLoop } from '../../src/services/minebot/integration/commonFca/controlLoop.js';
export { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';
export { createProbeBot, closeProbeBot } from '../../src/services/minebot/testing/MinecraftProbeBot.js';
