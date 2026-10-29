// Un nom oublié dans un import ne se voit ni à `node --check` ni aux tests :
// il fait planter la passerelle au premier message qui passe par lui. Le
// 29/10, `reglagesManquants` aurait ainsi mis le boîtier en boucle au premier
// relevé d'un capteur. Le lint le voit avant.
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.node },
    rules: { 'no-undef': 'error', 'no-unused-vars': 'warn' },
  },
];
