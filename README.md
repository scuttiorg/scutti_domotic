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

**Depuis scutti.** Le module Domotique ouvre un tunnel en trois étapes et donne une ligne à coller dans le terminal du Raspberry :

```sh
curl -fsSL https://<votre-scutti>/api/public/domotique/installer.sh | sudo bash -s SC-XXXX-XXXX
```

Elle fait tout : Docker, pare-feu (SSH seul), mises à jour automatiques, utilisateur de service, systemd durci, mot de passe MQTT tiré au sort, échange du code d'installation contre le jeton, démarrage des conteneurs et du service. Le jeton n'est jamais affiché ni recopié.

**À la main**, si besoin : `sudo ./raspberry/install.sh`, puis renseigner `SCUTTI_URL` et `SCUTTI_TOKEN` dans `/opt/chauffage/gateway/.env`.

Mosquitto n'écoute que sur `127.0.0.1`, et **l'interface web de Zigbee2MQTT est retirée** : l'appairage et le nommage des appareils se font dans scutti, qui écrit des commandes que la passerelle vient chercher. Le Raspberry n'expose donc aucun port hors SSH.

Tests de la logique : `cd raspberry/gateway && npm test`.

## Ce que la passerelle fait

| Quand | Quoi |
|---|---|
| toutes les `PULL_INTERVAL` s | `GET /configuration` : les pièces de tous les espaces admis, leurs règles, leur mode ; mis en cache |
| tant qu'une commande attend | le même passage, toutes les `PULL_INTERVAL_RAPIDE` s : `GET /commandes`, exécution sur le bridge (`permit_join`, `device/rename`), puis acquittement |
| à chaque changement du réseau Zigbee | `PUT /appareils` : la liste entière, avec le type déduit des `exposes`, le modèle, la batterie et la dernière vue ; au plus toutes les `APPAREILS_INTERVAL` s |
| à chaque relevé MQTT | calcule la consigne en vigueur et pilote la prise (hystérésis) |
| toutes les minutes | réévalue les règles horaires, coupe un capteur muet |
| toutes les `PUSH_INTERVAL` s | `POST /releves` : température, humidité, état du radiateur, consigne appliquée |
| à l'arrêt | coupe toutes les prises |

## Sécurité

- Jeton 256 bits, stocké haché côté scutti, jamais affiché ; `https://` imposé, TLS vérifié (CA interne possible), pas de redirection suivie.
- Code d'installation court, valable trente minutes, à usage unique : c'est lui qui s'échange contre le jeton, et le débit de l'échange est compté par adresse.
- Relevés MQTT filtrés (plages de valeurs) ; horodatages bornés côté scutti.
- Raspberry : aucun port exposé hors SSH, MQTT authentifié, service systemd sans privilèges, mises à jour automatiques, SSH par clé.
- Fail-safe : coupure si capteur muet, coupure à l'arrêt du service.
