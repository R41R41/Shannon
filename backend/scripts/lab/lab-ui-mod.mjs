// The ShannonUIMod settings of a public lab world (MINECRAFT_LAB_UI_MOD=true in minecraft-isolated-lab.mjs).
// Both of its HTTP ports are loopback-only and derived from the game port, so two labs never collide:
// backend (the probe's MinebotHttpServer) = game + 3600, mod push server = game + 3800. For the public
// range 25500-25600 that is 29100-29200 and 29300-29400, away from every range the VM's firewall opens.
export const UI_MOD_BACKEND_OFFSET = 3600;
export const UI_MOD_PUSH_OFFSET = 3800;
const FIREWALL_OPEN = [[7777, 7777], [8080, 8085], [14000, 14200], [25500, 25600]];

export function labUiModPorts(gamePort) {
  const ports = { backendPort: gamePort + UI_MOD_BACKEND_OFFSET, httpServerPort: gamePort + UI_MOD_PUSH_OFFSET };
  for (const value of Object.values(ports)) {
    if (!Number.isInteger(value) || value < 1024 || value > 65535
      || FIREWALL_OPEN.some(([low, high]) => value >= low && value <= high)) throw new Error(`UI mod port unusable: ${value}`);
  }
  return ports;
}

export function labUiModConfig({ gamePort, botPlayerName = 'I_am_Shannon', backendToken }) {
  if (!/^[A-Za-z0-9_]{3,16}$/.test(botPlayerName)) throw new Error('MINECRAFT_LAB_BOT_NAME must be a Minecraft name');
  // The backend refuses tokens shorter than 32 characters.
  if (!/^[0-9a-f]{48}$/.test(backendToken ?? '')) throw new Error('UI mod token must be 48 hex characters');
  const { backendPort, httpServerPort } = labUiModPorts(gamePort);
  return { backendHost: '127.0.0.1', backendPort, backendToken, httpServerPort, httpServerBindAddress: '127.0.0.1', botPlayerName };
}

/** The jars a lab copies into its mods/: exactly one Fabric API and one ShannonUIMod (not a sources jar). */
export function pickUiModJars(fileNames) {
  const pick = pattern => {
    const matches = fileNames.filter(name => pattern.test(name));
    if (matches.length !== 1) throw new Error(`Need exactly one jar matching ${pattern} in MINECRAFT_LAB_MODS_DIR, found ${matches.length}`);
    return matches[0];
  };
  return [pick(/^fabric-api-.+\.jar$/), pick(/^shannonuimod-(?!.*-(sources|dev)\.jar$).+\.jar$/)];
}
