#!/usr/bin/python3
"""One bounded unprivileged request. No retries and no model-supplied arguments."""
import json
import os
import pathlib
import secrets
import subprocess
import tempfile
import time

REQUEST = pathlib.Path('/run/shannon-home-start/request')
UNIT = 'shannon-home.service'

def process_tick(pid):
    return pathlib.Path('/proc/%s/stat' % pid).read_text().rsplit(') ', 1)[1].split()[19]

def publish(request, payload):
    fd, temporary = tempfile.mkstemp(prefix='.request-', dir=str(request.parent))
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(payload, stream); stream.flush(); os.fsync(stream.fileno())
        # Complete-file publication, without replacing an outstanding request.
        info = os.stat(temporary)
        os.link(temporary, request)
        return (info.st_dev, info.st_ino, payload['nonce'])
    finally:
        os.unlink(temporary)

def remove_own_request(request, identity):
    try:
        fd = os.open(request, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return
    try:
        info = os.fstat(fd)
        if (info.st_dev, info.st_ino) != identity[:2] or info.st_size > 1024:
            return
        payload = json.loads(os.read(fd, 1025))
        if payload.get('nonce') != identity[2]:
            return
        current = request.lstat()
        if (current.st_dev, current.st_ino) == (info.st_dev, info.st_ino):
            request.unlink()
    except (OSError, ValueError, AttributeError):
        pass
    finally:
        os.close(fd)

def command(args, timeout=3):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()

def wait_ready(request, payload, identity, read=command, monotonic=time.monotonic, clock=time.time, sleep=time.sleep):
    deadline = monotonic() + 60
    def bounded_read(args):
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise RuntimeError('HOME_READY_TIMEOUT')
        return read(args, timeout=min(3, remaining))
    try:
        while monotonic() < deadline:
            if bounded_read(['/usr/bin/systemctl', 'show', UNIT, '--property=ActiveState', '--value']) == 'active' and bounded_read(['/usr/bin/ss', '-H', '-ltn', 'sport = :25560']):
                return
            if clock() >= payload['expiresAt'] and request.exists():
                raise RuntimeError('HOME_REQUEST_EXPIRED')
            sleep(min(0.25, max(0, deadline - monotonic())))
        raise RuntimeError('HOME_READY_TIMEOUT')
    finally:
        remove_own_request(request, identity)

def main():
    if command(['/usr/bin/systemctl', 'show', UNIT, '--property=LoadState', '--value']) != 'loaded':
        raise RuntimeError('HOME_UNIT_NOT_LOADED')
    if command(['/usr/bin/systemctl', 'show', UNIT, '--property=ActiveState', '--value']) != 'inactive':
        raise RuntimeError('HOME_NOT_STOPPED')
    if command(['/usr/bin/ss', '-H', '-ltn', 'sport = :25560']):
        raise RuntimeError('HOME_LISTENER_EXISTS')
    payload = {'pid': os.getpid(), 'startTick': process_tick(os.getpid()), 'expiresAt': time.time() + 15,
               'nonce': secrets.token_hex(16)}
    identity = publish(REQUEST, payload)
    wait_ready(REQUEST, payload, identity)

if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('HOME_START_UNCONFIRMED')
