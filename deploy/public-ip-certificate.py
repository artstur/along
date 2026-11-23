#!/usr/bin/env python3
"""Issue or renew the Along IP certificate, then reconcile nginx's active leaf."""

import argparse
import fcntl
import hashlib
import ipaddress
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

DEPLOY = Path(__file__).resolve().parent
CERT_NAME = "along-public-ip"


def run(args, *, capture=False, timeout=20, data=None):
    return subprocess.run(
        args, check=True, timeout=timeout, input=data, stdin=subprocess.DEVNULL if data is None else None,
        stdout=subprocess.PIPE if capture else None, stderr=subprocess.PIPE if capture else None,
    ).stdout


def certbot(action, ip):
    command = [
        "docker", "compose", "run", "--rm", "--no-deps", "-T", "acme",
        "--non-interactive", "--config-dir", "/var/along-acme/config",
        "--work-dir", "/var/along-acme/work", "--logs-dir", "/var/along-acme/logs",
        "--cert-name", CERT_NAME, "--required-profile", "shortlived",
    ]
    if action == "bootstrap":
        command.extend([
            "certonly", "--agree-tos", "--email", os.environ["ALONG_ACME_EMAIL"],
            "--webroot", "--webroot-path", "/var/www/along-acme", "--ip-address", ip,
        ])
    else:
        command.append("renew")
    run(command, timeout=240)


def fingerprint(pem):
    der = run(["openssl", "x509", "-outform", "DER"], capture=True, data=pem)
    return hashlib.sha256(der).hexdigest()


def wait_for_leaf(connect, ip, expected, ca_options):
    for _ in range(10):
        try:
            pem = run([
                "openssl", "s_client", "-connect", connect, "-noservername", "-verify_return_error",
                "-verify_ip", ip, *ca_options,
            ], capture=True, timeout=4)
            if fingerprint(pem) == expected:
                return
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            pass
        time.sleep(1)
    raise RuntimeError("nginx TLS probe did not observe the expected trusted IP certificate")


def write_active_config(edge, content):
    # Write inside the nginx mount namespace, including during rollback. Colima's
    # host-backed mounts can otherwise briefly lose the name on repeated renames.
    run([*edge, "sh", "-ec", """
        dir=/etc/nginx/along-tls/config
        staged=$(mktemp "$dir/.config.XXXXXX")
        trap 'rm "$staged"' EXIT
        cat > "$staged"
        mv -f "$staged" "$dir/active.conf"
        trap - EXIT
    """], data=content)


def reconcile(directory, ip):
    tls = directory / "tls"
    active = tls / "config/active.conf"
    previous = active.read_bytes()
    old_release = re.search(rb"/releases/(ip-[a-f0-9]{64})/fullchain\.pem;", previous)
    if previous.strip() and old_release is None:
        raise RuntimeError("unexpected Along TLS active configuration")
    lineage = directory / "acme/config/live" / CERT_NAME
    ca_file = os.environ.get("ALONG_EDGE_CA_FILE")
    ca_options = ["-CAfile", ca_file] if ca_file else []
    connect = os.environ.get("ALONG_EDGE_PROBE", "127.0.0.1:443")
    edge = ["docker", "compose", "exec", "-T", "edge"]
    nginx = [*edge, "nginx"]
    releases = tls / "releases"
    releases.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=releases, prefix=".candidate-") as work:
        candidate = Path(work)
        fullchain = candidate / "fullchain.pem"
        key = candidate / "privkey.pem"
        for source in (fullchain, key):
            shutil.copyfile(lineage / source.name, source)
            source.chmod(0o600)
        template = (DEPLOY / "nginx/https.conf").read_bytes()
        run(["openssl", "verify", *ca_options, "-purpose", "sslserver",
             "-verify_ip", ip, "-untrusted", str(fullchain), str(fullchain)])
        leaf_pem = fullchain.read_bytes()
        public_key = run(["openssl", "x509", "-pubkey", "-noout"], capture=True, data=leaf_pem)
        if public_key != run(["openssl", "pkey", "-in", str(key), "-pubout"], capture=True):
            raise RuntimeError("Along TLS private key does not match the certificate")
        leaf = fingerprint(leaf_pem)
        # Include the chain and nginx config so a change to either gets its own release.
        release = releases / ("ip-" + hashlib.sha256(leaf_pem + template).hexdigest())
        if not release.exists():
            candidate.rename(release)
        certificate = release / "fullchain.pem"
        run(["openssl", "x509", "-in", str(certificate), "-checkend", "0", "-noout"])
        next_config = template.replace(b"@ALONG_TLS_RELEASE@", release.name.encode("ascii"))
        if previous == next_config:
            # Also verify the live worker when Certbot reports there was nothing to renew.
            # If it has not applied the active files, try the normal reload below.
            try:
                wait_for_leaf(connect, ip, leaf, ca_options)
                return certificate
            except RuntimeError:
                pass

        old_leaf = None
        if old_release is not None:
            previous_certificate = releases / old_release[1].decode("ascii") / "fullchain.pem"
            old_leaf = fingerprint(previous_certificate.read_bytes())
        reload_started = False
        write_active_config(edge, next_config)
        try:
            run([*nginx, "-t"])
            reload_started = True
            run([*nginx, "-s", "reload"])
            wait_for_leaf(connect, ip, leaf, ca_options)
        except Exception:
            write_active_config(edge, previous)
            if reload_started:
                try:
                    run([*nginx, "-t"])
                    run([*nginx, "-s", "reload"])
                    if old_leaf:
                        wait_for_leaf(connect, ip, old_leaf, ca_options)
                except (RuntimeError, subprocess.SubprocessError):
                    print("ALONG TLS ALERT: rollback reload/probe failed, inspect nginx immediately", file=sys.stderr)
            raise
        print(f"Along nginx is serving verified IP leaf SHA-256 {leaf}")
        return certificate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["bootstrap", "renew"])
    action = parser.parse_args().action
    address = ipaddress.IPv4Address(os.environ["ALONG_PUBLIC_IPV4"])
    if not address.is_global or address.is_multicast or address.is_reserved:
        raise ValueError("ALONG_PUBLIC_IPV4 must be a public unicast IPv4")
    ip = str(address)
    directory = Path(os.environ.get("ALONG_EDGE_DIR", "/opt/along/edge")).resolve()
    os.environ["ALONG_EDGE_DIR"] = str(directory)
    os.environ.setdefault("COMPOSE_FILE", os.pathsep.join(str(DEPLOY / name) for name in (
        "docker-compose.yml", "docker-compose.tier2.yml", "docker-compose.public-ip.yml",
    )))
    os.environ.setdefault("COMPOSE_PROFILES", "tier2")
    os.umask(0o077)
    with (directory / ".renew.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        certbot(action, ip)
        certificate = reconcile(directory, ip)
        run(["openssl", "x509", "-in", str(certificate),
             "-checkend", str(36 * 3600), "-noout"])


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, KeyError, ValueError, subprocess.SubprocessError) as error:
        print(f"ALONG TLS ALERT: certificate check, renewal or activation failed: {error}", file=sys.stderr)
        sys.exit(1)
