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
- Vue étudiant : la question telle qu'elle se présente dans un test StudiUM, avec réponses à
  choisir, bouton « Vérifier », note et rétroactions (présentation approchée du thème Moodle).
- Recherche plein texte, filtres par catégorie, type, statut et alertes.
- Sélection par cases à cocher (Maj+clic pour une plage) et suppression en lot, annulable.
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

Si la banque du navigateur est vide au lancement (autre navigateur, données du site effacées),
la sauvegarde la plus récente est restaurée en priorité, examens compris ; les fichiers d'origine
de `data_prive/` ne servent que s'il n'y a aucune sauvegarde, ou après « Vider la banque locale ».

Les données de l'application vivent dans le navigateur utilisé : changer de navigateur ou
effacer ses données de site vide la banque locale. Exportez régulièrement toute la banque.

## Développement

```
npm test          # tests de lecture/écriture (et de vos fichiers dans data_prive/ s'il y en a)
npm run typecheck
npm run build
```

## Formules mathématiques

Les formules TeX sont affichées comme dans StudiUM, avec les mêmes délimiteurs : `\( ... \)` dans le texte, `\[ ... \]` ou `$$ ... $$` sur une ligne à part. Dans l'éditeur, on tape le TeX tel quel ; l'aperçu à côté montre le rendu. Le fichier exporté n'est pas modifié.

## Assistant Claude

Le bouton **Claude** (en haut) ouvre un panneau de dialogue pour générer de nouvelles questions ou améliorer la question sélectionnée. Chaque proposition s'affiche en aperçu, avec **Ajouter à la banque** (comme brouillon) ou **Remplacer la question sélectionnée** (l'ancienne version reste dans l'historique).

Deux façons de le faire fonctionner, sans rien configurer dans l'application :

- **Claude Code installé et connecté** sur l'ordinateur : l'assistant passe par lui, avec votre abonnement. C'est le mode par défaut.
- **Clé d'API Anthropic** : collez-la dans `data_prive/cle_claude.txt` (dossier jamais commité) ou dans la variable `ANTHROPIC_API_KEY`. La clé a priorité si elle existe. Le modèle se change avec la variable `QR_CLAUDE_MODEL` (par défaut `claude-opus-5-5`).

Confidentialité : seuls vos messages et le texte de la question jointe (case « Joindre la question sélectionnée ») sont envoyés à Anthropic. Les images et le reste de la banque ne quittent pas l'ordinateur.
