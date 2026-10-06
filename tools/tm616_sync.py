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
  SYNC_INTERVAL         300 (secondes, minimum 60) — valeur de départ : dès que Planning répond, l'intervalle
                        choisi dans l'interface (page Présence → TimeMoto → « Fréquence de lecture ») la remplace.
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


INTERVAL_MIN_S, INTERVAL_MAX_S = 60, 3600
HEARTBEAT_S = 60   # entre deux lectures, un signe de vie par minute : c'est lui qui rapporte le réglage de l'interface
TICK_S = 5


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
    # ommit_ping=True (faute de frappe de pyzk, c'est bien son nom) : sans cela pyzk lance la commande
    # système `ping`, absente de l'image python:slim -> « can't reach device (ping ...) » même quand la
    # pointeuse répond. Si elle est réellement injoignable, connect() échoue de toute façon (délai dépassé).
    zk = ZK(ip, port=port, timeout=15, password=commkey, force_udp=False, ommit_ping=True)
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


def adopt_interval(cfg, body, log=print):
    """Reprend l'intervalle (secondes) renvoyé par Planning, borné à 60 s – 1 h. Absent = on garde le courant."""
    try:
        sec = int((body or {}).get("intervalSec"))
    except (TypeError, ValueError):
        return False
    sec = max(INTERVAL_MIN_S, min(INTERVAL_MAX_S, sec))
    if sec == cfg["interval"]:
        return False
    log(f"Intervalle de lecture réglé par Planning : {cfg['interval']} s -> {sec} s.")
    cfg["interval"] = sec
    return True


def heartbeat(cfg, log=print):
    """Signe de vie sans lecture de la pointeuse : met à jour le voyant et récupère l'intervalle choisi."""
    try:
        status, body = post(cfg["url"], cfg["key"], {"host": socket.gethostname(), "interval": cfg["interval"]})
    except Exception:
        return False
    if status == 200:
        adopt_interval(cfg, body, log)
        return True
    return False


def cycle(ZK, cfg, log=print):
    """Un passage : lecture + envoi. Renvoie True si Planning a bien reçu les événements."""
    try:
        users, atts = read_device(ZK, cfg["ip"], cfg["port"], cfg["commkey"])
    except Exception as e:  # pointeuse éteinte/injoignable : on le signale à Planning (voyant)
        msg = f"Pointeuse injoignable ({cfg['ip']}:{cfg['port']}) : {e}"
        log(msg)
        try:
            status, body = post(cfg["url"], cfg["key"], {"host": socket.gethostname(), "deviceError": msg, "interval": cfg["interval"]})
            if status == 200:
                adopt_interval(cfg, body, log)
        except Exception:
            pass
        return False
    payload = build_payload(users, atts, cfg["days"])
    payload["interval"] = cfg["interval"]
    try:
        status, body = post(cfg["url"], cfg["key"], payload)
    except Exception as e:
        log(f"Planning injoignable ({cfg['url']}) : {e}")
        return False
    if status == 200:
        adopt_interval(cfg, body, log)
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
          f"({cfg['days']} derniers jours) -> {cfg['url']} (intervalle ajustable dans Planning)", flush=True)
    log = lambda m: print(time.strftime("%Y-%m-%d %H:%M:%S"), m, flush=True)
    last_sync = last_beat = None
    while True:
        now = time.monotonic()
        if last_sync is None or now - last_sync >= cfg["interval"]:
            cycle(ZK, cfg, log=log)
            last_sync = last_beat = time.monotonic()
        elif now - last_beat >= HEARTBEAT_S:
            heartbeat(cfg, log=log)
            last_beat = now
        time.sleep(TICK_S)


if __name__ == "__main__":
    main()
