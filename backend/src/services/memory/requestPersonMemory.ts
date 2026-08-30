import { bindPersonRequest, personSource, validPersonQuote, PERSON_SCOPE_REQUIRED,
  type PersonMemoryPort, type PersonRequest, type PersonWriteResult } from '../../modules/memory/personMemory.js';
import { personStatementRepository, type PersonStatementRepository } from './personStatementRepository.js';

/** Captures author, audience, source and text before the first await. Construction does no I/O. */
export function createRequestPersonMemory(request?: PersonRequest, repository: PersonStatementRepository = personStatementRepository): PersonMemoryPort {
  const binding = bindPersonRequest(request);
  const source = request ? personSource(request) : null;
  const sourceText = request?.text;
  const denied = (): PersonWriteResult => ({ saved: false, message: PERSON_SCOPE_REQUIRED });
  const invalid = (): PersonWriteResult => ({ saved: false, message: '現在の本人発言からの引用と出典を確認できないため保存しません。' });
  return Object.freeze({
    async recall(limit?: number) { return binding ? repository.recall(binding, limit) : []; },
    async remember(quote: string) {
      if (!binding) return denied();
      if (!source || !validPersonQuote(quote, sourceText)) return invalid();
      try {
        const row = await repository.insert(binding, quote, source);
        return row ? { saved: true, message: 'この会話の範囲で本人の発言を保存しました。', statement: row }
          : { saved: false, message: 'この発言の引用は登録・訂正・忘却済みのため、別の引用で上書きしません。' };
      } catch { return { saved: false, message: '人物記憶の保存に失敗しました。' }; }
    },
    async correct(id: string, revision: number, quote: string) {
      if (!binding) return denied();
      if (!source || !validPersonQuote(quote, sourceText)) return invalid();
      try {
        const row = await repository.correct(binding, id, revision, quote, source);
        return row ? { saved: true, message: '同じ出典メッセージの編集を人物記憶へ反映しました。', statement: row }
          : { saved: false, message: '対象の版が変わったか、この会話で訂正できない記憶です。' };
      } catch { return { saved: false, message: '人物記憶の訂正に失敗しました。' }; }
    },
    async forget(id: string, revision: number) {
      if (!binding) return denied();
      try {
        return await repository.forget(binding, id, revision)
          ? { saved: true, message: 'この人物記憶の本文を削除し、同じ出典の再登録を止めました。' }
          : { saved: false, message: '対象の版が変わったか、この会話で忘却できない記憶です。' };
      } catch { return { saved: false, message: '人物記憶の忘却に失敗しました。' }; }
    },
  });
}
