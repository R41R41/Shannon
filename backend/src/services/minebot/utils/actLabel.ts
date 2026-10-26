/** One act step in a few words, for the result's lines and the UI mod's task tab ("dig (12,40,7)", "walk → (3,64,9)"). */
export interface StepLike {
  do?: string; to?: unknown; path?: unknown[]; at?: unknown; block?: string; item?: string; count?: number; target?: string | number;
  seconds?: number; n?: number; goals?: unknown[];
}

const pos = (spec: unknown): string => {
  if (!spec || typeof spec !== 'object') return '';
  const p = spec as Record<string, number>;
  return 'x' in p ? `(${p.x},${p.y},${p.z})` : `(前${p.front ?? 0}・右${p.right ?? 0}・上${p.up ?? 0})`;
};

export function stepLabel(step: StepLike): string {
  const at = Array.isArray(step.at) ? step.at.map(pos).join(' ') : pos(step.at);
  switch (step.do) {
    case 'walk': return `walk → ${step.path?.length ? `${step.path.length}マスの道` : pos(step.to)}`;
    case 'go': return `go → ${step.goals?.length ? `${step.goals.length}か所のどれか` : pos(step.to)}`;
    case 'dig': case 'place': return `${step.do}${step.block ? ` ${step.block}` : ''} ${at}`.trim();
    case 'use': return `use ${step.item ?? '手の物'}${at ? ` ${at}` : ''}${step.target !== undefined ? ` → ${step.target}` : ''}`;
    case 'craft': return `craft ${step.item}×${step.count ?? 1}`;
    case 'attack': case 'shoot': return `${step.do} ${step.target ?? at}`;
    case 'wait': return `wait ${step.seconds ?? 1}秒`;
    case 'pillarUp': return `pillarUp ${step.n ?? 1}段 ${step.block ?? ''}`.trim();
    default: return `${step.do ?? '?'}${step.item ? ` ${step.item}` : ''}${at ? ` ${at}` : ''}`;
  }
}
