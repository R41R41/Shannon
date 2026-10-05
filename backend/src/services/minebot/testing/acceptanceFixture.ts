/** The entire advertised search cube is reset, including upper floating logs.
 * Slabs remain below vanilla /fill's 32,768-block limit. This is lab-only.
 */
export function flatAcceptanceSetup(): string[] {
  const commands: string[] = [];
  for (let y = 76; y <= 124; y += 8) commands.push(`/fill -24 ${y} -24 24 ${Math.min(y + 7, 124)} 24 air`);
  commands.push('/fill -24 99 -24 24 99 24 stone', '/tp @s 0 100 0');
  return commands;
}
