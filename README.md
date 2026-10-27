# scutti_domotic

La passerelle Raspberry du module Domotique de scutti : capteurs et prises
Zigbee lus et commandés sur place, pièces, règles et modes réglés dans
scutti.

```
capteur Zigbee ──┐                                   ┌── scutti : pièces, règles, modes
                 ├─ dongle → Zigbee2MQTT → Mosquitto ─┤
prise Zigbee  ───┘            (Docker)                └── gateway (Node) ⇄ HTTPS ⇄ /api/public/domotique/passerelle
```

- **Un Raspberry par passerelle**, identifié par le jeton que scutti affiche à sa déclaration.
- La **passerelle décide localement** (consigne ± hystérésis, même règle que scutti) et continue sur la dernière configuration connue si scutti est injoignable.
- **Sécurité physique** : sans relevé capteur depuis `SENSOR_TIMEOUT`, le radiateur est coupé.
- Une passerelle sert **plusieurs espaces** scutti : chacun crée ses pièces, le Raspberry les chauffe toutes.

## Installation

```sh
sudo ./raspberry/install.sh   # Docker, ufw (SSH only), unattended-upgrades, utilisateur de service, systemd durci
```
Puis suivre les instructions affichées : `.env` (MQTT, jeton Zigbee2MQTT), `gateway/.env` (`SCUTTI_URL`, `SCUTTI_TOKEN`), `docker compose up -d`, appairage via tunnel SSH, démarrage du service.

Mosquitto et l'interface Zigbee2MQTT n'écoutent que sur `127.0.0.1`. Accès à l'interface : `ssh -L 8080:127.0.0.1:8080 pi@<ip>`.

Dans Zigbee2MQTT, nommer chaque capteur et chaque prise comme dans la pièce correspondante de scutti (`atelier/thermo`, `atelier/radiateur`).

Tests de la logique : `cd raspberry/gateway && npm test`.

## Ce que la passerelle fait

| Quand | Quoi |
|---|---|
| toutes les `PULL_INTERVAL` s | `GET /configuration` : les pièces de tous les espaces admis, leurs règles, leur mode ; mis en cache |
| à chaque relevé MQTT | calcule la consigne en vigueur et pilote la prise (hystérésis) |
| toutes les minutes | réévalue les règles horaires, coupe un capteur muet |
| toutes les `PUSH_INTERVAL` s | `POST /releves` : température, humidité, état du radiateur, consigne appliquée |
| à l'arrêt | coupe toutes les prises |

## Sécurité

- Jeton 256 bits, stocké haché côté scutti, jamais réaffiché ; `https://` imposé, TLS vérifié (CA interne possible), pas de redirection suivie.
- Relevés MQTT filtrés (plages de valeurs) ; horodatages bornés côté scutti.
- Raspberry : aucun port exposé hors SSH, MQTT authentifié, service systemd sans privilèges, mises à jour automatiques, SSH par clé.
- Fail-safe : coupure si capteur muet, coupure à l'arrêt du service.
