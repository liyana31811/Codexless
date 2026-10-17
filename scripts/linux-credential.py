#!/usr/bin/python3
"""Dedicated Tunnel runtime key in GNOME Secret Service; never in argv or logs."""
import argparse
import json
import os
import re
import socket
import stat
import subprocess
import sys


def attributes(tunnel_id):
    if not re.fullmatch(r"tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}", tunnel_id):
        raise ValueError("A complete Ubuntu Tunnel ID is required")
    return {"application": "codexless-linux", "purpose": "tunnel-runtime", "tunnel-id": tunnel_id}


def secret_api():
    import gi
    gi.require_version("Secret", "1")
    from gi.repository import Secret
    schema = Secret.Schema.new("org.codexless.linux.Tunnel", Secret.SchemaFlags.NONE,
                               {key: Secret.SchemaAttributeType.STRING for key in
                                ("application", "purpose", "tunnel-id")})
    return Secret, schema


def validate_key(value):
    value = value.strip()
    if not 16 <= len(value) <= 4096 or any(ord(c) < 33 or ord(c) > 126 for c in value):
        raise ValueError("Runtime key has an invalid format; nothing was saved")
    return value


def private_descriptor(fd):
    if fd is None or fd < 3:
        return False
    mode = os.fstat(fd).st_mode
    if stat.S_ISFIFO(mode):
        return True
    if stat.S_ISSOCK(mode):
        with socket.socket(fileno=os.dup(fd)) as channel:
            return channel.family == socket.AF_UNIX
    return False


def main(argv=None, api=None, prompt=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("set", "check", "get", "delete"))
    parser.add_argument("--tunnel-id", required=True)
    parser.add_argument("--fd", type=int)
    args = parser.parse_args(argv)
    if os.geteuid() == 0:
        raise ValueError("Run as the regular desktop user, without sudo")
    attrs = attributes(args.tunnel_id)
    if args.action == "get" and not private_descriptor(args.fd):
        raise ValueError("Key retrieval requires a private pipe on descriptor 3 or higher")
    secret, schema = api if api is not None else secret_api()
    if args.action == "set":
        if prompt is None:
            result = subprocess.run(
                ["zenity", "--password", "--title=codexless-linux Tunnel runtime key"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False,
                timeout=600, env={key: value for key, value in os.environ.items()
                                 if key not in ("OPENAI_API_KEY", "CONTROL_PLANE_API_KEY",
                                                "CODEXLESS_LINUX_TUNNEL_API_KEY")})
            if result.returncode != 0:
                print(json.dumps({"saved": False, "cancelled": True}))
                return 2
            value = result.stdout.decode("utf-8")
        else:
            value = prompt()
        value = validate_key(value)
        saved = secret.password_store_sync(schema, attrs, secret.COLLECTION_DEFAULT,
                    "codexless-linux · Ubuntu Tunnel runtime key", value, None)
        value = None
        if not saved:
            raise RuntimeError("Secret Service did not save the dedicated runtime key")
        print(json.dumps({"saved": True, "storage": "GNOME Secret Service"}))
        return 0
    if args.action == "delete":
        removed = secret.password_clear_sync(schema, attrs, None)
        print(json.dumps({"removed": bool(removed)}))
        return 0
    value = secret.password_lookup_sync(schema, attrs, None)
    if args.action == "check":
        print(json.dumps({"configured": value is not None, "storage": "GNOME Secret Service"}))
        return 0 if value is not None else 2
    if value is None:
        raise RuntimeError("No dedicated runtime key is stored; use credential set locally")
    data = validate_key(value).encode("utf-8")
    while data:
        written = os.write(args.fd, data)
        data = data[written:]
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Libraries can include service/account details in errors. Never echo their body.
        print("codexless-linux credential operation failed; check the local keyring or input.", file=sys.stderr)
        sys.exit(1)
