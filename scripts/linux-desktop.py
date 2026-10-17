#!/usr/bin/python3
"""Install/restore a session-bound launcher, preserving the user's original ChatGPT desktop entry."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sys
import tempfile


def digest(data): return hashlib.sha256(data).hexdigest()

def atomic(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix=path.name+'.', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as stream: stream.write(data)
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)


def regular(path):
    if path.is_symlink(): raise ValueError('Desktop integration refuses symbolic links')
    if path.exists() and (not path.is_file() or path.stat().st_nlink != 1):
        raise ValueError('Desktop integration requires regular unlinked private files')


def locations(env=os.environ):
    home = Path(env['HOME'])
    if not home.is_absolute(): raise ValueError('HOME must be an absolute path')
    def xdg(name, fallback):
        override = env.get(name)
        return Path(override) if override and Path(override).is_absolute() else home/fallback
    config = xdg('XDG_CONFIG_HOME', '.config')/'codexless-linux'
    data = xdg('XDG_DATA_HOME', '.local/share')
    return home, config, data/'applications/chatgpt.desktop'


def executable_path(value):
    if not isinstance(value, str) or not value or '\0' in value or not Path(value).is_absolute():
        raise ValueError('A reviewed absolute --app-executable path is required for installation')
    try: executable = Path(value).resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise ValueError('The selected application executable does not exist') from error
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise ValueError('The selected application must be a regular executable file')
    return str(executable)


def operate(action, tunnel_id=None, env=os.environ, system_entry=Path('/usr/share/applications/chatgpt.desktop'), app_executable=None):
    home, config, desktop = locations(env)
    receipt = config/'desktop-integration.json'
    backup = config/'original-chatgpt.desktop'
    session = config/'session.json'
    for target in (config, desktop.parent):
        if target.is_symlink(): raise ValueError('Desktop integration directory cannot be a symbolic link')
    for target in (receipt, backup, desktop, session): regular(target)
    record = json.loads(receipt.read_text()) if receipt.exists() else None
    if action == 'status':
        return {'integrated': bool(record), 'matches': bool(record and desktop.exists() and digest(desktop.read_bytes()) == record['installedSha256']), 'autostart': False}
    if record:
        if not desktop.exists() or digest(desktop.read_bytes()) != record['installedSha256']:
            raise ValueError('The desktop entry was changed locally; preserve/review it before changing integration')
        if action == 'restore':
            if not backup.exists() or digest(backup.read_bytes()) != record['originalSha256']:
                raise ValueError('Original desktop entry backup does not match its receipt')
            if record['originalUserEntry']:
                atomic(desktop, backup.read_bytes(), record['originalMode'])
            else: desktop.unlink()
            receipt.unlink()
            return {'restored': True, 'sessionConfigPreserved': True, 'credentialsPreserved': True}
        if record['tunnelId'] != tunnel_id: raise ValueError('A different Tunnel is already configured; restore/review it first')
    if action == 'restore': return {'restored': True, 'alreadyRestored': True}
    if not re.fullmatch(r'tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}', tunnel_id or ''):
        raise ValueError('A complete dedicated Tunnel ID is required')
    existing_session = json.loads(session.read_text()) if session.exists() else None
    app = executable_path(app_executable if app_executable is not None else (existing_session or {}).get('appExecutable'))
    original_user = record['originalUserEntry'] if record else desktop.exists()
    original = (backup if record else desktop if original_user else system_entry).read_bytes()
    if record and digest(original) != record['originalSha256']:
        raise ValueError('Original desktop entry backup does not match its receipt')
    text = original.decode('utf-8')
    lines = text.splitlines(keepends=True)
    in_main = False
    exec_index = None
    for i, line in enumerate(lines):
        if line.startswith('['): in_main = line.strip() == '[Desktop Entry]'
        if in_main and line.startswith('Exec='):
            if exec_index is not None: raise ValueError('Ambiguous desktop Exec entries')
            exec_index = i
    if exec_index is None: raise ValueError('ChatGPT desktop entry has no main Exec command')
    argv = shlex.split(lines[exec_index][5:].strip())
    if not argv: raise ValueError('Empty ChatGPT launcher')
    if argv[-1] in ('%U', '%u'): argv.pop()
    if any('%' in arg for arg in argv): raise ValueError('Unsupported desktop field code; original entry is preserved')
    launcher = argv.pop(0)
    if not os.path.isabs(launcher): launcher = shutil.which(launcher, path=env.get('PATH'))
    if not launcher or not os.access(launcher, os.X_OK): raise ValueError('Original ChatGPT launcher is not executable')
    if Path(launcher).name.startswith('codexless-linux'): raise ValueError('Original launcher would recursively launch Codexless')
    wrapper = home/'.local/bin/codexless-linux-chatgpt'
    if not os.access(wrapper, os.X_OK): raise ValueError('Install the Codexless Linux ChatGPT session command first')
    new_session = {'launcher': launcher, 'appExecutable': app, 'tunnelId': tunnel_id}
    if argv: new_session['launcherArgs'] = argv
    if existing_session is not None and existing_session != new_session:
        raise ValueError('Existing session configuration differs; review it locally before changing integration')
    if record:
        if existing_session is None: raise ValueError('Installed session configuration is missing; restore/review it first')
        return {'integrated': True, 'alreadyInstalled': True, 'autostart': False}
    quoted = str(wrapper).replace('\\','\\\\').replace('"','\\"').replace('%','%%')
    lines[exec_index] = f'Exec="{quoted}" -- %U\n'
    installed = ''.join(lines).encode()
    config.mkdir(parents=True, exist_ok=True, mode=0o700)
    if backup.exists() and backup.read_bytes() != original:
        raise ValueError('A different original desktop backup exists; no files were overwritten')
    original_mode = desktop.stat().st_mode & 0o777 if original_user else 0o644
    session_existed = session.exists()
    try:
        atomic(backup, original)
        if not session_existed: atomic(session, (json.dumps(new_session, indent=2)+'\n').encode())
        atomic(desktop, installed, original_mode)
        record = {'applicationId': 'codexless-linux', 'tunnelId': tunnel_id, 'originalUserEntry': original_user,
                  'originalMode': original_mode, 'originalSha256': digest(original), 'installedSha256': digest(installed)}
        atomic(receipt, (json.dumps(record, indent=2)+'\n').encode())
    except Exception:
        if original_user: atomic(desktop, original, original_mode)
        elif desktop.exists(): desktop.unlink()
        if not session_existed and session.exists(): session.unlink()
        raise
    return {'integrated': True, 'autostart': False, 'originalLauncherPreserved': True, 'desktopEntry': str(desktop)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install', 'status', 'restore'])
    parser.add_argument('--tunnel-id')
    parser.add_argument('--app-executable', help='Reviewed absolute native application executable; required on first install')
    args = parser.parse_args()
    if os.geteuid() == 0: raise ValueError('Use the regular desktop user, without sudo')
    print(json.dumps(operate(args.action, args.tunnel_id, app_executable=args.app_executable), indent=2))


if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
