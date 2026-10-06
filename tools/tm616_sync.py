#!/usr/bin/env python3
"""Lecture automatique de la pointeuse TimeMoto TM-616 (protocole ZK, réseau local) -> Planning.

Tourne en boucle (conteneur annexe `zk-sync` de docker-compose.yml, ou à la main) : toutes les
SYNC_INTERVAL secondes, lit la pointeuse, ne garde que les SYNC_DAYS derniers jours (journées
entières) et envoie les événements à Planning (POST /api/presence/device-sync, clé DEVICE_SYNC_KEY).
Planning réconcilie par (salarié, jour) : renvoyer les mêmes événements ne crée jamais de doublon.

LECTURE SEULE : ne vide jamais la mémoire de la pointeuse, ne la désactive jamais (pas de
disable_device : une pointeuse « désactivée » refuserait les pointages des salariés pendant la lecture).

Variables d'environnement :
  ZK_IP (obligatoire)   adresse de la pointeuse, ex. 192.168.1.37
  ZK_PORT               4370
  ZK_COMMKEY            0   (mot de passe de communication de la pointeuse)
  PLANNING_URL          http://planning-atelier:3000
  DEVICE_SYNC_KEY       clé partagée avec Planning (obligatoire, >= 16 caractères)
  SYNC_INTERVAL         300 (secondes, minimum 60)
  SYNC_DAYS             3   (journées relues à chaque passage, 1 à 31)
"""
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta


def kind_of(punch):
    """0 = Entrée, 1 = Sortie ; tout le reste (porte, alarme...) est ignoré côté Planning."""
    if punch == 0:
        return "in"
    if punch == 1:
        return "out"
    return "other"


def build_payload(users, attendances, days, now=None):
    """Événements des `days` derniers jours (journées entières) + liste des salariés."""
    now = now or datetime.now()
    since = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    events = []
    for a in attendances:
        ts = a.timestamp
        if ts < since or not str(a.user_id).strip():
            continue
        events.append({
            "uid": str(a.user_id).strip(),
            "ts": ts.strftime("%Y-%m-%dT%H:%M:%S"),
            "kind": kind_of(a.punch),
        })
    events.sort(key=lambda e: (e["ts"], e["uid"]))
    return {
        "host": socket.gethostname(),
        "deviceRecords": len(attendances),
        "users": [{"uid": str(u.user_id), "name": u.name} for u in users],
        "events": events,
    }


def read_device(ZK, ip, port, commkey):
    zk = ZK(ip, port=port, timeout=15, password=commkey, force_udp=False, ommit_ping=False)
    conn = None
    try:
        conn = zk.connect()
        return conn.get_users(), conn.get_attendance()
    finally:
        if conn is not None:
            try:
                conn.disconnect()
            except Exception:
                pass


def post(url, key, payload):
    req = urllib.request.Request(
        url.rstrip("/") + "/api/presence/device-sync",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Device-Key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8") or "{}")
        except Exception:
            body = {}
        return e.code, body


def cycle(ZK, cfg, log=print):
    """Un passage : lecture + envoi. Renvoie True si Planning a bien reçu les événements."""
    try:
        users, atts = read_device(ZK, cfg["ip"], cfg["port"], cfg["commkey"])
    except Exception as e:  # pointeuse éteinte/injoignable : on le signale à Planning (voyant)
        msg = f"Pointeuse injoignable ({cfg['ip']}:{cfg['port']}) : {e}"
        log(msg)
        try:
            post(cfg["url"], cfg["key"], {"host": socket.gethostname(), "deviceError": msg})
        except Exception:
            pass
        return False
    payload = build_payload(users, atts, cfg["days"])
    try:
        status, body = post(cfg["url"], cfg["key"], payload)
    except Exception as e:
        log(f"Planning injoignable ({cfg['url']}) : {e}")
        return False
    if status == 200:
        r = body.get("result") or {}
        log(f"OK : {len(payload['events'])} événement(s) envoyé(s), {r.get('added', 0)} ajouté(s), "
            f"{r.get('cancelled', 0)} annulé(s), {r.get('unmapped', 0)} journée(s) sans salarié associé.")
        return True
    log(f"Refusé par Planning (HTTP {status}) : {body.get('error', '?')}")
    return False


def load_config(env=os.environ):
    ip = env.get("ZK_IP", "").strip()
    key = env.get("DEVICE_SYNC_KEY", "").strip()
    if not ip:
        raise SystemExit("ZK_IP non renseignée (adresse de la pointeuse).")
    if len(key) < 16:
        raise SystemExit("DEVICE_SYNC_KEY absente ou trop courte (16 caractères minimum).")
    return {
        "ip": ip,
        "port": int(env.get("ZK_PORT", "4370")),
        "commkey": int(env.get("ZK_COMMKEY", "0")),
        "url": env.get("PLANNING_URL", "http://planning-atelier:3000"),
        "key": key,
        "interval": max(60, int(env.get("SYNC_INTERVAL", "300"))),
        "days": max(1, min(31, int(env.get("SYNC_DAYS", "3")))),
    }


def main():
    try:
        from zk import ZK
    except ImportError:
        sys.exit("Bibliothèque manquante : pip install pyzk")
    try:
        cfg = load_config()
    except SystemExit as e:
        # Conteneur lancé sans configuration : on le dit une fois puis on attend, sans boucle de
        # redémarrage (restart: unless-stopped relancerait sinon le conteneur en continu).
        print(f"Lecture automatique inactive : {e}", flush=True)
        while True:
            time.sleep(3600)
    print(f"Lecture automatique de {cfg['ip']}:{cfg['port']} toutes les {cfg['interval']} s "
          f"({cfg['days']} derniers jours) -> {cfg['url']}", flush=True)
    while True:
        cycle(ZK, cfg, log=lambda m: print(time.strftime("%Y-%m-%d %H:%M:%S"), m, flush=True))
        time.sleep(cfg["interval"])


if __name__ == "__main__":
    main()
