// Ce que la passerelle sait du réseau Zigbee, et qu'elle remonte à Scutti.
//
// POURQUOI ICI PLUTÔT QUE DANS SCUTTI : seule la passerelle voit le bridge.
// Scutti n'est que le miroir de cette liste, et c'est elle qui tranche ce
// qui existe. En échange, Scutti ne sait rien de Zigbee2MQTT.
//
// LE TYPE SE DÉDUIT DES « EXPOSES », pas du modèle : un catalogue de
// références serait faux le jour où un appareil change de firmware, et il
// faudrait le tenir à jour à la main. Ce que l'appareil déclare savoir
// faire, lui, est toujours juste.
//
// Un appareil qui mesure une température ou une humidité est un CAPTEUR ;
// un appareil qui expose un état commandable est une PRISE ; le reste est
// « autre », et reste utilisable dans Scutti, qui ne refuse pas une liste
// pour un modèle qu'il ne reconnaît pas.

/** Les propriétés qui font un capteur. */
const MESURES = ['temperature', 'humidity'];

/**
 * Les propriétés d'un `expose`, à plat : Zigbee2MQTT décrit un composite
 * (une prise à deux sorties, un thermostat) par des `features` imbriquées,
 * et la propriété qui nous intéresse peut s'y trouver.
 */
function proprietes(expose, sortie = []) {
  if (!expose || typeof expose !== 'object') return sortie;
  if (typeof expose.property === 'string') sortie.push({ property: expose.property, access: expose.access ?? 0 });
  for (const feature of expose.features ?? []) proprietes(feature, sortie);
  return sortie;
}

/** `capteur`, `prise` ou `autre`, d'après ce que l'appareil déclare exposer. */
export function deduireType(definition) {
  const toutes = (definition?.exposes ?? []).flatMap((e) => proprietes(e));
  if (toutes.some((p) => MESURES.includes(p.property))) return 'capteur';
  // Le bit 2 d'`access` est l'écriture : un état qu'on peut seulement LIRE
  // (le contact d'une porte) n'est pas une prise.
  if (toutes.some((p) => p.property === 'state' && (p.access & 0b10) !== 0)) return 'prise';
  return 'autre';
}

/**
 * Ce qu'on peut demander à une prise de relire, parmi ce que Scutti compte :
 * `power`, la puissance du moment (W), et `energy`, le compteur cumulé (kWh)
 * qu'elle tient elle-même et qui ne perd rien quand le boîtier est éteint.
 * Le bit 4 d'`access` dit qu'elle accepte la demande ; sans lui, Zigbee2MQTT
 * répondrait par une erreur. Vide pour une prise qui ne mesure rien.
 */
export function mesuresDe(definition) {
  const lisibles = (definition?.exposes ?? []).flatMap((e) => proprietes(e))
    .filter((p) => (p.access & 0b100) !== 0)
    .map((p) => p.property);
  return ['power', 'energy'].filter((m) => lisibles.includes(m));
}

/** Un nombre que la prise a mesuré, ou null : un `NaN` ou un négatif ne partent pas. */
export function mesure(valeur) {
  return typeof valeur === 'number' && Number.isFinite(valeur) && valeur >= 0 ? valeur : null;
}

/**
 * La liste à envoyer à Scutti, depuis `bridge/devices` et ce que les
 * appareils ont dit d'eux-mêmes depuis le démarrage.
 *
 * Le coordinateur (la clé USB elle-même) est écarté : il n'est ni un
 * capteur ni une prise, et il n'a rien à faire dans un choix de pièce.
 */
export function construireAppareils(devices, vus = new Map()) {
  return (devices ?? [])
    .filter((d) => d && d.type !== 'Coordinator' && d.ieee_address && d.friendly_name)
    .map((d) => {
      const vu = vus.get(d.friendly_name) ?? {};
      return {
        ieee: d.ieee_address,
        nom_z2m: d.friendly_name,
        type: deduireType(d.definition),
        modele: d.definition?.model ?? null,
        batterie: typeof vu.batterie === 'number' ? vu.batterie : null,
        temperature: typeof vu.temperature === 'number' ? vu.temperature : null,
        vu_le: vu.vuLe ?? null,
        puissance_w: mesure(vu.puissance),
        energie_kwh: mesure(vu.energie),
      };
    });
}

/**
 * Ce qui, dans la liste, décrit le RÉSEAU : qui est là, sous quel nom, de
 * quel type. La batterie, la température, la date de dernière vue et ce que
 * mesure une prise en sont exclues : elles changent à chaque relevé, et
 * c'est pour elles seules que vaut le plancher entre deux envois.
 *
 * Un appareil qui vient d'être appairé change cette signature deux fois :
 * à son arrivée, puis quand Zigbee2MQTT a fini de l'interroger et connaît
 * son modèle. Les deux doivent partir tout de suite, sinon Scutti le
 * montrerait cinq minutes comme « autre ».
 */
export function signature(appareils) {
  return (appareils ?? [])
    .map((a) => [a.ieee, a.nom_z2m, a.type, a.modele ?? ''].join('|'))
    .sort()
    .join('\n');
}
