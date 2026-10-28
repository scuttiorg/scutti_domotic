// Le seul script de l'interface locale, et il ne fait qu'une chose : un
// formulaire marqué `data-auto` se poste quand on change sa liste.
//
// Sans lui, chaque rangée demande un clic sur « Valider » : la page reste
// donc utilisable sans JavaScript, et le bouton n'est caché que lorsque
// celui-ci a bien chargé.

document.addEventListener('DOMContentLoaded', () => {
  for (const formulaire of document.querySelectorAll('form[data-auto]')) {
    // Une CLASSE, et pas `hidden` : le kit pose `display: inline-flex` sur
    // `.k-button`, qui l'emporte sur le `display: none` du navigateur, et le
    // bouton resterait visible.
    for (const bouton of formulaire.querySelectorAll('[data-sans-js]')) bouton.classList.add('boitier-cache');
    formulaire.addEventListener('change', () => formulaire.submit());
  }
});
