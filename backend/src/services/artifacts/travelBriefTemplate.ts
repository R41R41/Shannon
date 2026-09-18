import type { TripBrief } from './types.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function text(value: string | undefined): string {
  return escapeHtml(value?.trim() ?? '');
}

function renderList(items: string[] | undefined, emptyText: string): string {
  if (!items?.length) return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  return `<ul>${items.map((item) => `<li>${text(item)}</li>`).join('')}</ul>`;
}

export function renderTravelBriefHtml(brief: TripBrief): string {
  const stops = brief.stops.map((stop, index) => `
    <section class="stop">
      <div class="stop-rail">
        <div class="time">${text(stop.time)}</div>
        <div class="dot">${index + 1}</div>
      </div>
      <div class="stop-card">
        <h3>${text(stop.title)}</h3>
        ${stop.place ? `<div class="place">📍 ${text(stop.place)}</div>` : ''}
        <p>${text(stop.description)}</p>
        <div class="chips">
          ${stop.travel ? `<span>🚶 ${text(stop.travel)}</span>` : ''}
          ${stop.cost ? `<span>¥ ${text(stop.cost)}</span>` : ''}
          ${stop.reservation ? `<span>予約 ${text(stop.reservation)}</span>` : ''}
        </div>
      </div>
    </section>`).join('');

  const sources = brief.sources.map((source) => {
    const safeUrl = /^https?:\/\//i.test(source.url) ? escapeHtml(source.url) : '#';
    return `<li><a href="${safeUrl}">${text(source.label)}</a>${source.note ? ` — ${text(source.note)}` : ''}</li>`;
  }).join('');

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${text(brief.title)}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #f2f8fc; color: #12212d; }
    body { font-family: "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", sans-serif; font-size: 15px; line-height: 1.7; }
    .page { width: 100%; max-width: 960px; margin: 0 auto; background: #ffffff; }
    .hero { padding: 46px 54px 42px; color: #ffffff; background: #086ea7; }
    .eyebrow { font-size: 12px; letter-spacing: .14em; opacity: .82; text-transform: uppercase; }
    h1 { margin: 8px 0 4px; font-size: 36px; line-height: 1.25; letter-spacing: -.02em; }
    .subtitle { margin: 0; font-size: 17px; opacity: .9; }
    .hero-meta { margin-top: 24px; }
    .hero-meta span { display: inline-block; margin: 0 16px 6px 0; padding: 5px 11px; border: 1px solid rgba(255,255,255,.35); border-radius: 999px; }
    main { padding: 38px 54px 50px; }
    .intro { font-size: 17px; margin: 0 0 28px; color: #274453; }
    .summary-grid { display: table; width: 100%; border-spacing: 12px 0; margin: 0 -12px 34px; }
    .summary-card { display: table-cell; width: 50%; padding: 18px 20px; vertical-align: top; border-radius: 14px; background: #eef7fb; }
    .summary-card strong { display: block; margin-bottom: 6px; color: #086ea7; font-size: 13px; }
    h2 { margin: 34px 0 18px; font-size: 22px; color: #064e75; }
    .stop { display: table; width: 100%; margin-bottom: 16px; page-break-inside: avoid; }
    .stop-rail { display: table-cell; width: 100px; vertical-align: top; text-align: right; padding-right: 18px; }
    .time { font-weight: 700; color: #086ea7; font-variant-numeric: tabular-nums; }
    .dot { display: inline-block; width: 28px; height: 28px; margin-top: 8px; border-radius: 50%; color: #fff; background: #16a6d9; text-align: center; line-height: 28px; font-weight: 700; }
    .stop-card { display: table-cell; padding: 18px 20px; border: 1px solid #d7e8f1; border-radius: 14px; background: #fff; box-shadow: 0 5px 18px rgba(14, 88, 126, .07); }
    .stop-card h3 { margin: 0 0 4px; font-size: 18px; }
    .stop-card p { margin: 9px 0 0; }
    .place { color: #4b6978; font-size: 13px; }
    .chips { margin-top: 12px; }
    .chips span { display: inline-block; margin: 0 7px 5px 0; padding: 3px 9px; border-radius: 999px; background: #eef7fb; color: #315b70; font-size: 12px; }
    .two-column { display: table; width: 100%; border-spacing: 12px 0; margin: 0 -12px; }
    .panel { display: table-cell; width: 50%; padding: 18px 20px; vertical-align: top; border-radius: 14px; background: #f7fafc; }
    .panel h2 { margin-top: 0; }
    ul { margin: 8px 0; padding-left: 1.35em; }
    li { margin-bottom: 7px; }
    a { color: #0877b1; word-break: break-all; }
    .sources { margin-top: 36px; padding-top: 20px; border-top: 1px solid #d7e8f1; font-size: 12px; color: #546c79; }
    .sources h2 { margin-top: 0; font-size: 17px; }
    .muted { color: #718793; }
    footer { padding: 18px 54px 28px; color: #6c828e; font-size: 11px; background: #f7fafc; }
    @media (max-width: 680px) {
      .hero, main, footer { padding-left: 24px; padding-right: 24px; }
      h1 { font-size: 29px; }
      .summary-grid, .two-column, .summary-card, .panel { display: block; width: 100%; margin: 0 0 12px; }
      .stop-rail { width: 72px; padding-right: 12px; }
    }
  </style>
</head>
<body>
  <article class="page">
    <header class="hero">
      <div class="eyebrow">Shannon Travel Brief</div>
      <h1>${text(brief.title)}</h1>
      ${brief.subtitle ? `<p class="subtitle">${text(brief.subtitle)}</p>` : ''}
      <div class="hero-meta">
        <span>📅 ${text(brief.date)}</span>
        ${brief.participants ? `<span>👥 ${text(brief.participants)}</span>` : ''}
      </div>
    </header>
    <main>
      <p class="intro">${text(brief.introduction)}</p>
      <div class="summary-grid">
        <div class="summary-card"><strong>集合</strong>${text(brief.meetingPoint || '依頼者と確認')}</div>
        <div class="summary-card"><strong>天候・服装</strong>${text(brief.weatherNote || '直前の予報を確認')}</div>
      </div>

      <h2>当日の流れ</h2>
      ${stops}

      <div class="two-column">
        <section class="panel"><h2>見どころ</h2>${renderList(brief.highlights, '当日の気分に合わせて楽しみましょう。')}</section>
        <section class="panel"><h2>雨天時の代案</h2>${renderList(brief.rainPlan, '小雨決行。荒天時は屋内施設へ切り替えます。')}</section>
      </div>

      <section><h2>メモ</h2>${renderList(brief.notes, '特記事項はありません。')}</section>
      <section class="sources">
        <h2>参照元</h2>
        <ul>${sources}</ul>
        <p>営業時間・料金・運行情報は変更される場合があります。出発前にリンク先で最新情報をご確認ください。</p>
      </section>
    </main>
    <footer>Shannonが作成した旅行案内です。生成日時: ${escapeHtml(new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }))}</footer>
  </article>
</body>
</html>`;
}

export const travelBriefTemplateInternals = { escapeHtml };
