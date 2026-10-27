# Chauffage

Pilotage de radiateurs à distance : capteurs et prises Zigbee sur un Raspberry Pi, pièces et règles gérées dans scuti.

```
capteur Zigbee ──┐                                   ┌── interface scuti (pièces, règles, modes)
                 ├─ dongle → Zigbee2MQTT → Mosquitto ─┤
prise Zigbee  ───┘            (Docker)                └── gateway (Node) ⇄ HTTPS ⇄ API scuti
```

- **Un Raspberry par site**, identifié par un token.
- La **passerelle décide localement** (consigne ± hystérésis) et continue sur la dernière config connue si scuti est injoignable.
- **Sécurité physique** : sans relevé capteur depuis `SENSOR_TIMEOUT`, le radiateur est coupé.

## Modèle

| Objet  | Rôle |
|--------|------|
| Site   | un Raspberry ; token de passerelle (haché en base, affiché une seule fois) |
| Pièce  | capteur + prise Zigbee2MQTT, consigne par défaut, hystérésis, mode `off / auto / manual` |
| Règle  | par pièce : jours, plage horaire (peut traverser minuit), consigne, priorité |

Consigne en vigueur : mode `off` → rien ; mode `manual` (non expiré) → consigne manuelle ; sinon première règle active qui matche par priorité croissante ; sinon consigne par défaut.

## Raspberry (`raspberry/`)

```sh
sudo ./install.sh          # Docker, ufw (SSH only), unattended-upgrades, utilisateur de service, systemd durci
```
Puis suivre les instructions affichées : `.env` (MQTT, token Zigbee2MQTT), `gateway/.env` (token scuti), `docker compose up -d`, appairage via tunnel SSH, démarrage du service.

Mosquitto et l'interface Zigbee2MQTT n'écoutent que sur `127.0.0.1`. Accès à l'interface : `ssh -L 8080:127.0.0.1:8080 pi@<ip>`.

Tests de la logique : `cd gateway && npm test`.

## scuti (`scuti/`)

1. Appliquer `modules/heating/migration.sql`.
2. `npm i @fastify/rate-limit` et enregistrer le module :
   ```js
   app.register(heatingRoutes, {
     prefix: '/api/heating',
     db,                                   // better-sqlite3 (prepare/get/all/run/transaction)
     requireUser: scutiAuthHook,           // refuse les non-connectés
     isAdmin: (req) => req.user.role === 'admin',
   });
   ```
3. Servir `public/heating/` ; aligner `heating.css` sur la charte.

### API

| Méthode | Route | Accès |
|---|---|---|
| GET | `/sites` | utilisateur |
| POST | `/sites` · `/sites/:id/rotate-token` | admin — renvoie le token une seule fois |
| DELETE | `/sites/:id` | admin |
| GET | `/rooms` · `/rooms/:id` · `/rooms/:id/history?hours=` | utilisateur |
| POST/PUT/DELETE | `/rooms` · `/rooms/:id` | admin |
| PUT | `/rooms/:id/mode` | utilisateur |
| POST/PUT/DELETE | `/rules` · `/rules/:id` | utilisateur |
| GET | `/gateway/config` | passerelle (Bearer token de site) |
| POST | `/gateway/readings` | passerelle, 60 req/min, body ≤ 64 Ko |

## Sécurité — récapitulatif

- Token de site 256 bits, stocké en SHA‑256, rotation possible, jamais réaffiché.
- Passerelle : HTTPS imposé, TLS vérifié (CA interne possible), pas de redirection suivie, relevés MQTT filtrés (plages de valeurs).
- scuti : Zod strict partout, horodatages bornés, rate‑limit et limite de taille sur les routes passerelle, erreurs sans stack, cloisonnement par site.
- Raspberry : aucun port exposé hors SSH, MQTT authentifié, service systemd sans privilèges (`ProtectSystem=strict`, `NoNewPrivileges`…), mises à jour automatiques, SSH par clé.
- Fail-safe : coupure si capteur muet, coupure à l'arrêt du service.
