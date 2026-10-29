// LES ALLUMAGES ET LES EXTINCTIONS, À LA SECONDE.
//
// Le relevé périodique part toutes les cinq minutes : un radiateur allumé
// entre deux relevés y apparaissait jusqu'à cinq minutes trop tard, et une
// chauffe brève pas du tout. Chaque basculement part donc aussitôt, en
// relevé horodaté au moment où les prises ont été commandées : c'est lui que
// le graphique de Scutti montre.
//
// Hors ligne, ils attendent ici et partent au retour, dans l'ordre. Scutti
// refuse un relevé de plus de vingt-quatre heures, et refuserait le lot
// entier pour un seul : on les oublie à vingt-trois heures.
//
// Un relevé porte la liste des prises allumées : un lot de cent relevés de
// pièces à douze prises dépasserait les 64 Kio que Scutti accepte par envoi,
// et serait refusé à chaque essai. Le lot s'arrête donc aussi au poids.

const PLUS_VIEUX = 23 * 3600_000;
const LOT = 100;          // le maximum d'un envoi de relevés
const POIDS_MAX = 48 * 1024; // sous les 64 Kio d'un envoi, enveloppe comprise
const FILE_MAX = 500;     // une coupure de plusieurs jours ne remplit pas la mémoire

export default class Basculements {
  constructor(maintenant = Date.now) {
    this.maintenant = maintenant;
    this.file = [];
  }

  noter(releve) {
    this.file.push(releve);
    if (this.file.length > FILE_MAX) this.file.shift();
  }

  /** Les plus anciens d'abord, au plus un lot, sans ceux que Scutti refuserait. */
  aEnvoyer() {
    const limite = this.maintenant() - PLUS_VIEUX;
    this.file = this.file.filter((r) => Date.parse(r.mesure_le) >= limite);
    let poids = 0;
    let n = 0;
    for (const releve of this.file.slice(0, LOT)) {
      poids += Buffer.byteLength(JSON.stringify(releve)) + 1;
      // Le premier part toujours : seul, il tient dans un envoi.
      if (n > 0 && poids > POIDS_MAX) break;
      n++;
    }
    return this.file.slice(0, n);
  }

  /** Le lot rendu par aEnvoyer() est arrivé : il sort de la file. */
  envoyes(nombre) {
    this.file.splice(0, nombre);
  }
}
