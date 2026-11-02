import { feetCell, type Cell } from '../localMap.js';
import { blockAt, cellText } from './common.js';
import { holdsWater } from '../waterBlocks.js';
import { assessWaterExits } from '../worksiteAssessment.js';

/** Render local construction facts. Being above a block is not evidence of breathable air. */
export function waterExitWords(bot: any, feet: Cell): string | null {
  const candidates = assessWaterExits(bot, feet);
  if (!candidates.length) return null;
  return `水際の足場候補: ${candidates.slice(0, 2).map(candidate => {
    const floor = candidate.attach
      ? `${cellText(candidate.floor)} に ${candidate.attach.name}${cellText(candidate.attach.at)} に当てて置く必要がある`
      : `${cellText(candidate.floor)} は ${candidate.floorName}（床になる）`;
    const work = candidate.dig.length ? `。上の ${candidate.dig.map(cell => `${cellText(cell.at)} ${cell.name}`).join('・')} の掘削が必要` : '';
    const breath = candidate.breathing === 'observed_air' ? '足と頭は現在空気（到達経路は別に確認）'
      : candidate.breathing === 'submerged' ? '頭は水中のまま。呼吸できる出口ではない' : '施工後に呼吸できるかは未確認';
    return `${floor}${work}。立ち位置候補 ${cellText(candidate.stand)}、${breath}${candidate.unknowns.length ? `（${candidate.unknowns.join('・')}）` : ''}`;
  }).join('／')}`;
}

/** Facts only; the policy for choosing work/retreat belongs to the decision instructions. */
export function deepWaterWords(bot: any): string | null {
  const feet = feetCell(bot);
  if (!feet || !holdsWater(blockAt(bot, feet)) || !holdsWater(blockAt(bot, { ...feet, y: feet.y - 1 }))) return null;
  const exit = waterExitWords(bot, feet);
  return `深い水の中（足の下も水で床が無い。掘る・置く間も沈むことがあり、頭が水中なら息が減る）${exit ? `。${exit}` : '。近くの呼吸できる足場は未確認'}`;
}
