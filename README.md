# QR_studium

Application web **locale** destinée aux professeurs pour lire, corriger et créer des questions
StudiUM (Moodle), parcourir rapidement une banque de questions, assembler des examens et
faire évoluer questions et réponses dans le temps.

Tout reste sur le poste : les questions sont stockées dans le navigateur (IndexedDB) et
aucune donnée n'est envoyée sur Internet.

## Démarrer

Il faut [Node.js](https://nodejs.org) (version 20 ou plus récente).

```
npm install
npm start
```

Sous Windows, un double-clic sur `lancer.bat` fait la même chose. L'application s'ouvre à
l'adresse http://localhost:5173.

Si PowerShell répond « l'exécution de scripts est désactivée sur ce système », utilisez
`lancer.bat` ou tapez `npm.cmd start` à la place de `npm start`.

## Utilisation

1. Dans StudiUM : *Banque de questions › Exporter › Format Moodle XML*.
2. Dans l'application : **Importer un XML** (ou glisser-déposer le fichier). Plusieurs
   fichiers peuvent être importés ; les questions déjà présentes sont ignorées.
3. Parcourir (↑ ↓), rechercher (`/`), modifier (`e`), ajouter à un examen (`a`).
4. **Exporter** les questions affichées, toute la banque ou un examen, puis dans StudiUM :
   *Banque de questions › Importer › Format Moodle XML*.

Un examen est exporté dans une catégorie portant son nom : dans StudiUM, il suffit ensuite
d'ajouter au test toutes les questions de cette catégorie.

## Fonctionnalités

- Lecture et écriture du format Moodle XML, images intégrées comprises. Les éléments non
  interprétés (unités, indices, types de questions rares) sont conservés tels quels.
- Aperçu avec corrigé : choix multiple, vrai/faux, appariement, cloze, réponse courte,
  numérique, description.
- Recherche plein texte, filtres par catégorie, type, statut et alertes.
- Éditeur par type de question avec aperçu en direct ; création et duplication en variante.
- Contrôle qualité : fractions incohérentes, absence de bonne réponse, images manquantes ou
  inutilisées, doublons, HTML collé depuis Word, cloze mal formé.
- Historique des versions de chaque question, avec restauration.
- Statut et note privée par question (non exportés).
- Examens : sélection, ordre, total des points, export XML, impression (copie et corrigé).
- Rapport d'analyse (JSON) : notes de révision rattachées aux questions par l'étiquette
  `id-origine-<ID>` (pertinence, direction, problème, correction proposée), filtres associés,
  vue d'ensemble (défauts récurrents, lacunes, questions suggérées) et export des notes à jour.

## Données privées

Les banques de questions réelles vont dans `data_prive/`, ignoré par git, comme tout fichier
`.xml` hors de `tests/fixtures/`. Ne jamais versionner de vraies questions d'examen.

Au lancement, l'application charge d'elle-même les fichiers `.xml` et `.json` posés directement
dans `data_prive/` (les nouveaux et ceux qui ont changé depuis le dernier chargement).

Quelques secondes après chaque modification, l'application écrit une sauvegarde dans
`data_prive/sauvegardes/` : `banque-AAAA-MM-JJ.xml` (toute la banque, réimportable dans
l'application ou dans StudiUM) et `notes-AAAA-MM-JJ.json` (notes de révision, statuts, notes
privées, composition des examens). Il y a une sauvegarde par jour, réécrite au fil de la journée ;
les trois derniers jours sont conservés. L'historique des versions n'est pas sauvegardé.

Les données de l'application vivent dans le navigateur utilisé : changer de navigateur ou
effacer ses données de site vide la banque locale. Exportez régulièrement toute la banque.

## Développement

```
npm test          # tests de lecture/écriture (et de vos fichiers dans data_prive/ s'il y en a)
npm run typecheck
npm run build
```
