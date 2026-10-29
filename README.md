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

`install.sh` se relance sans danger : il ne touche ni aux `.env` (jeton, mot de passe MQTT) ni à `zigbee2mqtt/configuration.yaml`, où Zigbee2MQTT a écrit la clé du réseau et les noms des appareils, et il redémarre un boîtier déjà relié sur le nouveau code.

## Mises à jour et reprise

Le boîtier se débrouille seul, une fois installé.

- **Mise à jour** : toutes les trente minutes, `chauffage-maj.timer` regarde la branche `main` de ce dépôt (public, lu sans identifiants depuis `/opt/chauffage/depot`). Une version nouvelle est posée par `install.sh`. Si la passerelle ne tient pas trente secondes sans redémarrer, le boîtier revient à la précédente et ne retente plus celle-là. Ce qui est fusionné dans `main` arrive donc sur tous les boîtiers dans la demi-heure. Pour ne pas attendre : `sudo systemctl start chauffage-maj`, et `journalctl -u chauffage-maj` pour lire ce qui s'est passé.
- **Wifi** : l'économie d'énergie du wifi est coupée, et NetworkManager retente la connexion sans fin au lieu d'abandonner après quatre échecs. Toutes les deux minutes, `chauffage-reseau.timer` vérifie que la box répond ; sinon il relance le wifi, et après une demi-heure sans réseau il redémarre le boîtier, au plus une fois toutes les six heures. Sans réseau, la régulation continue sur la dernière configuration connue.
- **Blocage** : le chien de garde matériel du Raspberry le redémarre si le système ne répond plus pendant quinze secondes, et une panique du noyau redémarre au bout de dix. La passerelle et les conteneurs redémarrent seuls, et le Raspberry repart de lui-même au retour du courant.

Mosquitto n'écoute que sur `127.0.0.1`, et **l'interface web de Zigbee2MQTT est retirée** : l'appairage et le nommage des appareils se font dans scutti, qui écrit des commandes que la passerelle vient chercher. Le Raspberry n'ouvre aucun port vers l'extérieur.

## L'interface locale

Le boîtier sert ses trois pages (pièces, appareils, réglages) sur le réseau du bâtiment, à `https://<nom-du-raspberry>.local:8080`. Elle existe pour le jour où scutti est injoignable : on y règle une consigne, un mode, on appaire un appareil et on le renomme, sans internet.

- Ouverte par `install.sh` sur les réseaux privés seulement (`10/8`, `172.16/12`, `192.168/16`), jamais vers l'extérieur ; `LOCAL_PORT=0` la coupe.
- **Être sur le wifi ne suffit pas.** Un wifi se pirate : l'interface demande un code d'accès, choisi dans scutti (Domotique, « Code d'accès sur place »). Sans code, elle est fermée, et un boîtier neuf l'est donc par défaut. Le boîtier ne reçoit jamais le code, seulement un vérificateur scrypt, dans la configuration qu'il lit avec son jeton ; il le garde en cache, et l'interface de secours s'ouvre donc aussi quand scutti est injoignable.
- **HTTPS seulement**, avec un certificat engendré sur le boîtier à l'installation (sa clé ne le quitte jamais). Le navigateur demande de l'accepter à la première visite : son empreinte doit être celle que scutti affiche à côté du code, sinon quelqu'un s'est glissé entre les deux.
- Cinq codes faux en un quart d'heure ferment la connexion, pour tout le boîtier et pas par adresse (changer d'adresse sur un réseau local ne coûte rien). Session dans un cookie `Secure`, `HttpOnly`, `SameSite=Strict`, de douze heures sans visite et sept jours au plus ; un code changé dans scutti met dehors les sessions ouvertes. Formulaires refusés s'ils ne viennent pas d'une page du boîtier, pas de cadre, pas de script étranger, rien en cache.
- Une page sans JavaScript reste utilisable : les boutons suffisent, le script ne fait qu'envoyer le formulaire au changement.
- Sa feuille de style est une copie engendrée du kit de scutti (`node scripts/kit-boitier.mjs` dans le dépôt scutti), pour que les deux interfaces ne divergent pas.

**Les deux côtés se règlent, aucun ne gagne.** Chaque champ d'une pièce ou d'un appareil voyage avec la date de sa dernière écriture, et la plus récente l'emporte, champ par champ : renommer la pièce dans scutti pendant qu'on change son mode sur le boîtier garde les deux. L'égalité ne renverse pas. L'état local vit dans `/var/lib/chauffage/local.json`, donc un réglage fait pendant une coupure survit au redémarrage et part au retour du réseau.

Tests de la logique : `cd raspberry/gateway && npm test`.

## Ce que la passerelle fait

| Quand | Quoi |
|---|---|
| toutes les `PULL_INTERVAL` s | `GET /configuration` : les pièces de tous les espaces admis, leurs règles, leur mode ; mis en cache |
| tant qu'une commande attend | le même passage, toutes les `PULL_INTERVAL_RAPIDE` s : `GET /commandes`, exécution sur le bridge (`permit_join`, `device/rename`), puis acquittement |
| à chaque changement du réseau Zigbee | `PUT /appareils` : la liste entière, avec le type déduit des `exposes`, le modèle, la batterie et la dernière vue ; au plus toutes les `APPAREILS_INTERVAL` s |
| à chaque relevé MQTT | calcule la consigne en vigueur et pilote la prise (hystérésis) |
| toutes les minutes | réévalue les règles horaires, coupe un capteur muet |
| à chaque passage | `POST /echange` : les pièces et les appareils avec la date de chaque champ, dans les deux sens |
| toutes les `PUSH_INTERVAL` s | `POST /releves` : température, humidité, état du radiateur, consigne appliquée |
| à l'arrêt | coupe toutes les prises |

## Sécurité

- Jeton 256 bits, stocké haché côté scutti, jamais affiché ; `https://` imposé, TLS vérifié (CA interne possible), pas de redirection suivie.
- Code d'installation court, valable trente minutes, à usage unique : c'est lui qui s'échange contre le jeton, et le débit de l'échange est compté par adresse.
- Relevés MQTT filtrés (plages de valeurs) ; horodatages bornés côté scutti.
- Raspberry : aucun port exposé hors SSH, MQTT authentifié, service systemd sans privilèges, mises à jour automatiques, SSH par clé.
- Le boîtier installe ce que contient `main` : fusionner dans `main`, c'est déployer sur tous les boîtiers. Le dépôt ne contient aucun secret ; jetons et mots de passe ne vivent que dans les `.env` du boîtier.
- Interface locale sur les réseaux privés seulement, en HTTPS, derrière un code d'accès dont le boîtier ne connaît que le vérificateur ; l'état local en 0600, dans le seul dossier où le service a le droit d'écrire.
- SSH : mot de passe refusé dès qu'une clé est posée, par un réglage lu avant tous les autres (`sshd_config.d/00-chauffage.conf`), pour qu'aucun réglage d'usine ne le rouvre.
- Fail-safe : coupure si capteur muet, coupure à l'arrêt du service.
