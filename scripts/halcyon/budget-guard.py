#!/usr/bin/env python3
"""Halcyon's own daily budget for her Minecraft body (not Shannon's ~/Shannon-runtime/minebot-model-budget.json).

The head (halcyon-head) books every paid model call it makes in its database (`llm_usage_events.estimated_cost_usd`): the Minecraft
decisions (Sonnet), the task model and summaries (Haiku), the Decisions provider, and anything else the head pays for. This sums the
UTC day's bookings of her head (all of them: conservative) and compares them with HALCYON_MINECRAFT_DAILY_USD (default 5).

  python3 -I budget-guard.py check     exit 0: room left; 3: the cap is reached (the body must leave); 2: could not read (fail closed)
  python3 -I budget-guard.py show      prints the state, always exit 0

The state is written to HALCYON_MINECRAFT_BUDGET_FILE (default ~/halcyon-minebot-data/minecraft-budget.json): {version, day, usd, capUsd,
exhausted, checkedAt}. The body (scripts/halcyon/body-run.ts) runs `check` at start and every minute; systemd runs it before start.
"""
import datetime
import json
import os
import sqlite3
import sys

HOME = os.path.expanduser('~')
DB = os.environ.get('HALCYON_HEAD_DB', os.path.join(HOME, 'halcyon-head-data', 'halcyon.sqlite'))
STATE = os.environ.get('HALCYON_MINECRAFT_BUDGET_FILE', os.path.join(HOME, 'halcyon-minebot-data', 'minecraft-budget.json'))


def cap_usd():
    try:
        value = float(os.environ.get('HALCYON_MINECRAFT_DAILY_USD', '5'))
        return value if value > 0 else 5.0
    except ValueError:
        return 5.0


def spent(day):
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True, timeout=10)
    try:
        row = db.execute('SELECT COALESCE(SUM(estimated_cost_usd), 0), COUNT(*) FROM llm_usage_events WHERE occurred_at >= ?', (f'{day}T00:00:00',)).fetchone()
        return float(row[0] or 0), int(row[1] or 0)
    finally:
        db.close()


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'check'
    now = datetime.datetime.now(datetime.timezone.utc)
    day = now.strftime('%Y-%m-%d')
    cap = cap_usd()
    try:
        usd, calls = spent(day)
    except Exception as error:  # noqa: BLE001 - any failure is no room
        print(json.dumps({'day': day, 'error': str(error)[:200]}))
        return 0 if mode == 'show' else 2
    state = {'version': 1, 'day': day, 'usd': round(usd, 4), 'calls': calls, 'capUsd': cap, 'exhausted': usd >= cap,
             'checkedAt': now.isoformat(timespec='seconds')}
    try:
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        tmp = STATE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as handle:
            json.dump(state, handle)
        os.replace(tmp, STATE)
    except OSError:
        pass
    print(json.dumps(state))
    if mode == 'show':
        return 0
    return 3 if state['exhausted'] else 0


if __name__ == '__main__':
    sys.exit(main())
