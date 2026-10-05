/**
 * The kinds of mob whose attack a reflex of the body answers.
 *
 * A kind that hits from afar is an emergency while the body stands in its reach: the task is stopped and the
 * body is taken out of sight. That is what a body with no answer has to do. One that strikes a ghast's ball
 * back, or raises a shield at an arrow, has an answer, and for it the emergency was the larger harm: in the
 * open of the Nether a ghast is always in sight, and near a fortress so is a blaze (paid runs L77j, L77k: the
 * task stopped twelve times in twenty minutes). Each reflex says here what it answers, as a test that is asked
 * again each time (a shield breaks, a reflex is switched off). The watch for hostiles leaves such a kind out of
 * "in its reach"; a hit that gets through is an attack as before.
 */
type Answers = (kind: string) => boolean;
interface Answering { reflexAnswers?: { has(kind: string): boolean; tests?: Answers[] } }

export function answerWith(bot: object, test: Answers): void {
  const host = bot as Answering;
  if (!host.reflexAnswers?.tests) {
    const tests: Answers[] = [];
    host.reflexAnswers = { tests, has: kind => tests.some(answers => { try { return answers(kind); } catch { return false; } }) };
  }
  host.reflexAnswers.tests!.push(test);
}

export function answeredByReflex(bot: object | null | undefined, kind: string | null | undefined): boolean {
  if (!kind) return false;
  try { return (bot as Answering | null | undefined)?.reflexAnswers?.has(kind.toLowerCase()) === true; } catch { return false; }
}
