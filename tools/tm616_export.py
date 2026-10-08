#!/usr/bin/env python3
"""Export des pointages de la pointeuse TimeMoto TM-616 en CSV, par le réseau local.

Lit la pointeuse DIRECTEMENT (protocole ZK, port 4370) : ni TimeMoto Cloud, ni reCAPTCHA, ni jeton.
Le fichier produit s'importe dans Planning (page Présence -> bouton « TimeMoto » -> « A. Fichier CSV »).

Installation (une fois) :   pip install pyzk
Utilisation :               python tm616_export.py --ip 192.168.1.37
Options :                   --port 4370  --commkey 0  --out pointages_tm616.csv

Colonnes : UID;UserID;Nom;Badge;Date;Heure;Action;Status  (séparateur « ; », UTF-8 avec BOM).
« Action » = sens enregistré par la pointeuse (Entrée / Sortie). Les événements sans salarié (porte,
alarme...) sont exportés tels quels : Planning les ignore. Le script ne modifie JAMAIS la pointeuse
(lecture seule : il ne vide pas la mémoire des pointages).
"""
import argparse
import csv
import sys
from pathlib import Path

try:
    from zk import ZK
except ImportError:
    sys.exit("Bibliothèque manquante : installez-la avec  pip install pyzk")


def action_label(punch):
    if punch == 0:
        return "Entrée"
    if punch == 1:
        return "Sortie"
    return f"Punch {punch}"


def export(ip, port, commkey, out_path):
    zk = ZK(ip, port=port, timeout=10, password=commkey, force_udp=False, ommit_ping=False)
    conn = None
    try:
        print(f"Connexion à la pointeuse {ip}:{port}...")
        conn = zk.connect()
        users = {str(u.user_id): u for u in conn.get_users()}
        attendances = conn.get_attendance()
        print(f"{len(users)} utilisateurs, {len(attendances)} pointages lus.")
        attendances.sort(key=lambda a: (a.timestamp, str(a.user_id)))
        with open(out_path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f, delimiter=";")
            w.writerow(["UID", "UserID", "Nom", "Badge", "Date", "Heure", "Action", "Status"])
            for a in attendances:
                u = users.get(str(a.user_id))
                w.writerow([
                    a.uid, a.user_id,
                    u.name if u else "INCONNU",
                    u.card if u else "",
                    a.timestamp.strftime("%d/%m/%Y"),
                    a.timestamp.strftime("%H:%M:%S"),
                    action_label(a.punch),
                    a.status,
                ])
        print(f"Fichier écrit : {Path(out_path).resolve()}")
    finally:
        if conn:
            conn.disconnect()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--ip", required=True, help="adresse IP de la pointeuse")
    ap.add_argument("--port", type=int, default=4370)
    ap.add_argument("--commkey", type=int, default=0, help="mot de passe de communication (0 par défaut)")
    ap.add_argument("--out", default="pointages_tm616.csv")
    args = ap.parse_args()
    try:
        export(args.ip, args.port, args.commkey, args.out)
    except Exception as e:  # message clair plutôt qu'une trace
        sys.exit(f"ERREUR : {type(e).__name__} : {e}")
