#!/usr/bin/python3
"""Root-owned fixed actuator. Consumes one request; never retries or starts another unit."""
import json
import math
import os
import pathlib
import pwd
import re
import stat
import subprocess
import time

REQUEST = pathlib.Path('/run/shannon-home-start/request')
UNIT = 'shannon-home.service'

def alive_original(payload, uid, proc=pathlib.Path('/proc')):
    try:
        status = (proc / str(payload['pid']) / 'status').read_text()
        actual_uids = re.search(r'^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$', status, re.M)
        tick = (proc / str(payload['pid']) / 'stat').read_text().rsplit(') ', 1)[1].split()[19]
        return bool(actual_uids) and all(int(value) == uid for value in actual_uids.groups()) and tick == payload['startTick']
    except (OSError, ValueError, IndexError, KeyError):
        return False

def valid(payload, info, uid, now, original):
    return isinstance(payload, dict) and set(payload) == {'pid', 'startTick', 'expiresAt', 'nonce'} and stat.S_ISREG(info.st_mode) and info.st_uid == uid and info.st_size <= 1024 \
        and type(payload['pid']) is int and payload['pid'] > 0 and isinstance(payload['startTick'], str) and re.fullmatch('[1-9][0-9]*', payload['startTick']) is not None \
        and isinstance(payload['nonce'], str) and re.fullmatch('[a-f0-9]{32}', payload['nonce']) is not None \
        and type(payload['expiresAt']) in (int, float) and math.isfinite(payload['expiresAt']) and now < payload['expiresAt'] <= now + 15 \
        and now - 15 <= info.st_mtime <= now + 1 and original(payload, uid)

def consume(request=REQUEST, runner=subprocess.run, original=alive_original, uid=None, clock=time.time):
    if uid is None:
        uid = pwd.getpwnam('azureuser').pw_uid
    try:
        fd = os.open(request, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        # Remove the fixed entry itself; never follow or write a symlink target.
        try: request.unlink()
        except FileNotFoundError: pass
        return False
    try:
        info = os.fstat(fd)
        try:
            raw = os.read(fd, 1025) if stat.S_ISREG(info.st_mode) and info.st_size <= 1024 else b''
            payload = json.loads(raw)
        except (ValueError, OSError):
            payload = None
        try:
            current = request.lstat()
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                return False
            # Keep the opened inode alive through unlink, preventing an inode-reuse race.
            request.unlink()
        except FileNotFoundError:
            return False
    finally:
        os.close(fd)
    if not valid(payload, info, uid, clock(), original):
        return False
    # Root-owned unit content is the authority. An ambiguous/active unit is never started here.
    result = runner(['/usr/bin/systemctl', 'show', UNIT, '--property=ActiveState', '--property=MainPID'],
                    capture_output=True, text=True, check=True, timeout=3)
    if set(result.stdout.strip().splitlines()) != {'ActiveState=inactive', 'MainPID=0'}:
        return False
    # Recheck the original wrapper and its finite deadline after the awaited manager read.
    if not valid(payload, info, uid, clock(), original):
        return False
    runner(['/usr/bin/systemctl', '--no-ask-password', 'start', UNIT], check=True, timeout=10)
    return True

if __name__ == '__main__':
    if len(os.sys.argv) != 1 or os.geteuid() != 0:
        raise SystemExit('HOME_REQUEST_HELPER_AUTHORITY')
    try:
        accepted = consume()
        print('HOME_REQUEST_STARTED' if accepted else 'HOME_REQUEST_REFUSED')
    except Exception:
        # The client/native operator retains any unconfirmed effect as unknown. No retry.
        print('HOME_REQUEST_UNCONFIRMED')
