#!/usr/bin/env python3
"""Lecture automatique de la pointeuse TimeMoto TM-616 (protocole ZK, réseau local) -> Planning.

Tourne en boucle (conteneur annexe `zk-sync` de docker-compose.yml, ou à la main) : toutes les
SYNC_INTERVAL secondes, lit la pointeuse, ne garde que les SYNC_DAYS derniers jours (journées
entières) et envoie les événements à Planning (POST /api/presence/device-sync, clé DEVICE_SYNC_KEY).
Planning réconcilie par (salarié, jour) : renvoyer les mêmes événements ne crée jamais de doublon.

Récupération à la demande : si un administrateur demande une période depuis la page Présence, la réponse de Planning à un
contact (battement de cœur compris) la porte (`recover`) ; l'agent relit alors la pointeuse et renvoie les journées
entières de cette période avec `recoverId` (aperçu, puis confirmation dans Planning).

Badges (v1.116.0) : si un administrateur a préparé ET confirmé une modification dans Planning (ajout d'un salarié,
changement de nom ou de badge, suppression), la réponse de Planning à un contact la porte (`badge`). L'agent l'écrit sur la
pointeuse (set_user / delete_user), RELIT la pointeuse pour vérifier, puis renvoie le résultat (`badgeResult`). Jamais de
biométrie (ni empreinte ni visage) ; le code (PIN) n'est jamais renvoyé à Planning (seulement « défini » ou non).

Hors modification de badge confirmée, LECTURE SEULE : ne vide jamais la mémoire de la pointeuse, ne la désactive jamais (pas de
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
import re
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
    """0 = Entrée, 1 = Sortie ; tout le reste est « other » (le code brut `punch` accompagne chaque événement : 2/3 = touches pause,
    4/5 = heures sup, lues seulement pour un salarié réglé « par ordre de passage » côté Planning ; porte/alarme ignorées)."""
    if punch == 0:
        return "in"
    if punch == 1:
        return "out"
    return "other"


def user_payload(u):
    """Un salarié de la pointeuse pour Planning : nom, n° de badge, « code défini » (jamais le code lui-même)."""
    return {
        "uid": str(u.user_id),                  # UserID : identifiant des pointages (zk:<UserID> dans Planning)
        "name": u.name,
        "slot": getattr(u, "uid", None),                          # emplacement interne de la pointeuse
        "card": int(getattr(u, "card", 0) or 0),
        "hasPin": bool(str(getattr(u, "password", "") or "").strip()),
        "privilege": int(getattr(u, "privilege", 0) or 0),
    }


def build_payload(users, attendances, days, now=None, since_date=None, until_date=None):
    """Événements des `days` derniers jours (journées entières) + liste des salariés.

    `since_date`/`until_date` ("AAAA-MM-JJ", inclus) remplacent les `days` derniers jours : utilisé pour une
    récupération de période demandée depuis Planning (toujours des JOURNÉES ENTIÈRES)."""
    now = now or datetime.now()
    if since_date:
        since = datetime.strptime(since_date, "%Y-%m-%d")
        until = datetime.strptime(until_date or since_date, "%Y-%m-%d") + timedelta(days=1)
    else:
        since = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
        until = None
    events = []
    for a in attendances:
        ts = a.timestamp
        if ts < since or (until is not None and ts >= until) or not str(a.user_id).strip():
            continue
        events.append({
            "uid": str(a.user_id).strip(),
            "ts": ts.strftime("%Y-%m-%dT%H:%M:%S"),
            "kind": kind_of(a.punch),
            "punch": a.punch,   # code brut (0 entrée, 1 sortie, 2/3 pause, 4/5 heures sup, 255 porte...) : Planning décide s'il le lit
        })
    events.sort(key=lambda e: (e["ts"], e["uid"]))
    return {
        "host": socket.gethostname(),
        "deviceRecords": len(attendances),
        "users": [user_payload(u) for u in users],
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


DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def recover_period(ZK, cfg, rec, log=print):
    """Récupération à la demande : Planning a mis en attente une demande (page Présence → TimeMoto), reçue dans la
    réponse d'un contact. On relit la pointeuse (lecture seule) et on renvoie les journées ENTIÈRES de la période,
    avec l'identifiant de la demande ; Planning en fait un aperçu que l'administrateur confirme ensuite."""
    rid = str((rec or {}).get("id") or "")
    d1, d2 = str((rec or {}).get("from") or ""), str((rec or {}).get("to") or "")
    if not rid or not DATE_RE.match(d1) or not DATE_RE.match(d2) or d1 > d2:
        log(f"Demande de récupération invalide ignorée : {rec}")
        return False
    log(f"Récupération demandée par Planning : {d1} -> {d2}.")
    try:
        users, atts = read_device(ZK, cfg["ip"], cfg["port"], cfg["commkey"])
    except Exception as e:
        msg = f"Pointeuse injoignable ({cfg['ip']}:{cfg['port']}) : {e}"
        log(msg)
        try:
            post(cfg["url"], cfg["key"], {"host": socket.gethostname(), "deviceError": msg, "interval": cfg["interval"], "recoverId": rid})
        except Exception:
            pass
        return False
    payload = build_payload(users, atts, 1, since_date=d1, until_date=d2)
    payload["interval"] = cfg["interval"]
    payload["recoverId"] = rid
    try:
        status, body = post(cfg["url"], cfg["key"], payload)
    except Exception as e:
        log(f"Planning injoignable ({cfg['url']}) : {e}")
        return False
    if status == 200:
        log(f"Récupération : {len(payload['events'])} événement(s) envoyé(s) pour {d1} -> {d2} (aperçu à confirmer dans Planning).")
        return True
    log(f"Récupération refusée par Planning (HTTP {status}) : {body.get('error', '?')}")
    return False


def _name_bytes(name):
    return str(name or "").encode("utf-8")[:24].decode("utf-8", "ignore")


def perform_badge(conn, cmd):
    """Applique UNE modification de badge sur la pointeuse connectée puis la VÉRIFIE par relecture.
    Renvoie (ok, erreur, utilisateurs après). Revérifie tout sur la pointeuse avant d'écrire : la liste de Planning
    peut dater de quelques minutes (n° de badge pris entre-temps, emplacement réutilisé...)."""
    kind = cmd.get("kind")
    slot = cmd.get("slot")
    user_id = str(cmd.get("userId") or "")
    try:
        slot = int(slot)
        card = int(cmd.get("card") or 0)
    except (TypeError, ValueError):
        return False, "Demande invalide (emplacement ou n° de badge).", None
    if kind not in ("add", "edit", "delete") or not user_id:
        return False, "Demande invalide.", None
    users = conn.get_users()
    by_slot = {u.uid: u for u in users}
    cur = by_slot.get(slot)
    if kind in ("add", "edit"):
        name = _name_bytes(cmd.get("name"))
        if not name:
            return False, "Nom vide.", None
        if card:
            other = next((u for u in users if int(getattr(u, "card", 0) or 0) == card and u.uid != slot), None)
            if other is not None:
                return False, f"N° de badge déjà attribué à « {other.name} » sur la pointeuse.", None
    if kind == "add":
        if cur is not None:
            same = str(cur.user_id) == user_id and cur.name == name and int(getattr(cur, "card", 0) or 0) == card
            if not same:   # emplacement pris entre-temps par quelqu'un d'autre
                return False, "Emplacement déjà occupé sur la pointeuse : relancez la demande.", None
        elif any(str(u.user_id) == user_id for u in users):
            return False, f"Identifiant {user_id} déjà utilisé sur la pointeuse : relancez la demande.", None
        else:
            conn.set_user(uid=slot, name=name, privilege=0, password=str(cmd.get("pin") or ""), group_id="", user_id=user_id, card=card)
    elif kind == "edit":
        if cur is None or str(cur.user_id) != user_id:
            return False, "Ce salarié a changé ou disparu de la pointeuse : relancez la demande.", None
        if cmd.get("pin"):
            pw = str(cmd["pin"])
        elif cmd.get("clearPin"):
            pw = ""
        else:
            pw = str(getattr(cur, "password", "") or "")
        conn.set_user(uid=slot, name=name, privilege=getattr(cur, "privilege", 0), password=pw,
                      group_id=getattr(cur, "group_id", "") or "", user_id=cur.user_id, card=card)
    else:  # delete
        if cur is None:
            return True, None, users   # déjà absent : rien à faire
        if str(cur.user_id) != user_id:
            return False, "Ce salarié a changé de place sur la pointeuse : relancez la demande.", None
        if getattr(cur, "privilege", 0):
            return False, "Administrateur de la pointeuse : suppression refusée.", None
        conn.delete_user(uid=slot)
    after = conn.get_users()
    got = {u.uid: u for u in after}.get(slot)
    if kind == "delete":
        if got is not None:
            return False, "La relecture montre que le salarié est toujours sur la pointeuse.", after
    else:
        if got is None or got.name != name or int(getattr(got, "card", 0) or 0) != card or str(got.user_id) != (user_id if kind == "add" else str(cur.user_id)):
            return False, "Écriture non confirmée à la relecture de la pointeuse.", after
    return True, None, after


def run_badge(ZK, cfg, cmd, log=print):
    """Exécute une modification de badge confirmée dans Planning et renvoie le résultat. Renvoie la réponse de Planning
    (qui peut porter la modification suivante) ou None."""
    rid = str((cmd or {}).get("id") or "")
    if not rid:
        return None
    log(f"Badge : modification demandée par Planning ({cmd.get('kind')}, emplacement {cmd.get('slot')}).")
    res = {"id": rid, "ok": False}
    conn = None
    try:
        zk = ZK(cfg["ip"], port=cfg["port"], timeout=15, password=cfg["commkey"], force_udp=False, ommit_ping=True)
        conn = zk.connect()
        ok, err, after = perform_badge(conn, cmd)
        res["ok"], res["verified"] = ok, ok
        if err:
            res["error"] = err
        if after is not None:
            res["users"] = [user_payload(u) for u in after]
    except Exception as e:
        res["error"] = f"Pointeuse injoignable ou écriture refusée ({cfg['ip']}:{cfg['port']}) : {e}"
    finally:
        if conn is not None:
            try:
                conn.disconnect()
            except Exception:
                pass
    log(f"Badge : {'écrit et vérifié' if res['ok'] else 'ÉCHEC — ' + res.get('error', '?')}.")
    try:
        status, body = post(cfg["url"], cfg["key"], {"host": socket.gethostname(), "interval": cfg["interval"], "badgeResult": res})
    except Exception as e:
        log(f"Planning injoignable pour le résultat du badge : {e}")
        return None
    return body if status == 200 else None


def handle_badge(ZK, cfg, body, log=print):
    """Traite la modification portée par une réponse de Planning, puis les suivantes (5 au plus par contact)."""
    for _ in range(5):
        cmd = (body or {}).get("badge")
        if not cmd:
            return
        body = run_badge(ZK, cfg, cmd, log)


def heartbeat(cfg, log=print, ZK=None):
    """Signe de vie sans lecture de la pointeuse : met à jour le voyant, récupère l'intervalle choisi et
    découvre une éventuelle demande de récupération de période."""
    try:
        status, body = post(cfg["url"], cfg["key"], {"host": socket.gethostname(), "interval": cfg["interval"]})
    except Exception:
        return False
    if status == 200:
        adopt_interval(cfg, body, log)
        if ZK is not None and body.get("recover"):
            recover_period(ZK, cfg, body["recover"], log)
        if ZK is not None and body.get("badge"):
            handle_badge(ZK, cfg, body, log)
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
        if body.get("recover"):
            recover_period(ZK, cfg, body["recover"], log)
        if body.get("badge"):
            handle_badge(ZK, cfg, body, log)
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
            heartbeat(cfg, log=log, ZK=ZK)
            last_beat = now
        time.sleep(TICK_S)


if __name__ == "__main__":
    main()
