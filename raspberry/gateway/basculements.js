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

const PLUS_VIEUX = 23 * 3600_000;
const LOT = 100;          // le maximum d'un envoi de relevés
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
    return this.file.slice(0, LOT);
  }

  /** Le lot rendu par aEnvoyer() est arrivé : il sort de la file. */
  envoyes(nombre) {
    this.file.splice(0, nombre);
  }
}
