# QR_studium

Application web **locale** destinée aux professeurs pour lire, corriger et créer des questions
StudiUM (Moodle), parcourir rapidement une banque de questions, assembler des examens et
faire évoluer questions et réponses dans le temps.

Tout reste sur le poste : les questions sont stockées dans le navigateur (IndexedDB). Rien n'est
envoyé sur Internet, sauf ce que vous choisissez d'envoyer à l'assistant Claude (voir plus bas).

## Démarrer

Il faut [Node.js](https://nodejs.org) (version 20 ou plus récente).

```
npm install
npm start
```

Sous Windows, un double-clic sur `lancer.bat` fait la même chose. L'application s'ouvre à
l'adresse http://localhost:5173. La fenêtre de lancement doit rester ouverte : c'est elle qui
écrit les sauvegardes automatiques et fait le lien avec l'assistant Claude.

Si PowerShell répond « l'exécution de scripts est désactivée sur ce système », utilisez
`lancer.bat` ou tapez `npm.cmd start` à la place de `npm start`.

## Utilisation

1. Dans StudiUM : *Banque de questions › Exporter › Format Moodle XML*.
2. Dans l'application : **Importer (XML, JSON)**, ou glisser-déposer les fichiers. Plusieurs
   fichiers peuvent être importés à la fois ; les questions strictement identiques à une question
   déjà présente sont ignorées.
3. Parcourir (↑ ↓), rechercher (`/`), modifier (`e`), ajouter à un examen (`a`).
4. **Exporter** les questions affichées, toute la banque ou un examen, puis dans StudiUM :
   *Banque de questions › Importer › Format Moodle XML*.

Un examen est exporté dans une catégorie portant son nom : dans StudiUM, il suffit ensuite
d'ajouter au test toutes les questions de cette catégorie.

## Parcourir et organiser

- **Recherche** plein texte (énoncés, réponses, étiquettes, notes) et **filtres** : catégorie, type,
  statut, direction et pertinence de la note de révision, difficulté, alertes, distracteurs proposés.
- **Colonnes redimensionnables** : glisser la bordure entre deux colonnes ; double-clic pour revenir
  à la largeur d'origine. Les largeurs sont mémorisées.
- **Sélection par cases à cocher** (Maj+clic pour une plage) : suppression en lot et déplacement en
  lot vers une catégorie existante ou nouvelle, tous deux annulables.
- **Catégories** : renommer la catégorie sélectionnée, rechercher-remplacer dans les noms de toutes
  les catégories (par exemple retirer un préfixe « Cours 03 – »), supprimer les catégories vides.
  L'arbre suit l'ordre de la banque, pas l'ordre alphabétique.
- **Examen en cours** : chaque catégorie affiche entre parenthèses le nombre de ses questions déjà
  retenues dans l'examen.

## Lire une question

- **Aperçu avec corrigé** : choix multiple, vrai/faux, appariement, texte à trous (cloze), réponse
  courte, numérique (avec unités), description, glisser-déposer sur texte et sur image.
- **Vue étudiant** : la question telle qu'elle se présente dans un test StudiUM, avec réponses à
  donner, bouton « Vérifier », note et rétroactions. Le glisser-déposer sur image est interactif
  (étiquettes par groupe, étiquettes réutilisables, mélange). La présentation est une approximation
  du thème Moodle.
- **Formules mathématiques** : le TeX est affiché comme dans StudiUM, avec les mêmes délimiteurs,
  `\( ... \)` dans le texte et `\[ ... \]` ou `$$ ... $$` sur une ligne à part. Le fichier exporté
  n'est pas modifié.
- **Historique** des versions de chaque question, avec restauration.
- **Contrôle qualité** : fractions incohérentes, absence de bonne réponse, images manquantes ou
  inutilisées, doublons, HTML collé depuis Word, texte à trous mal formé.

## Modifier

- **Éditeur par type** de question avec aperçu en direct ; création, duplication en variante.
- **Réglages avancés** modifiables :
  - glisser-déposer sur texte : choix à déposer (texte, groupe, réutilisable), mélange ;
  - glisser-déposer sur image : zones déplaçables à la souris, étiquettes, image de fond, mélange ;
  - numérique : gestion des unités, pénalité, mode de saisie, liste des unités et multiplicateurs.
  Ce que l'éditeur ne sait pas modifier est conservé tel quel à l'export.
- **Nettoyer la mise en forme** (menu Exporter) : retire les paragraphes vides et les sauts de
  ligne en trop, restes de copier-coller qui ajoutent des lignes blanches. Le texte ne change pas.
- **Appliquer un fichier corrigé** (menu Exporter) : remplace le contenu des questions déjà dans la
  banque par celui d'un fichier Moodle XML corrigé. Les questions sont reconnues par leur
  étiquette `id-origine-<ID>` ou, à défaut, par leur type et leur nom ; rien n'est ajouté, et
  l'ancienne version de chaque question reste dans son historique.
- Statut et note privée par question (non exportés).

## Notes de révision, propositions et scores

Les questions sont reliées aux fichiers ci-dessous par leur étiquette `id-origine-<ID>` (ou, pour
les scores, par leur titre quand elles n'en ont pas). Tous s'importent avec **Importer (XML, JSON)** ;
l'application reconnaît chaque fichier à son contenu.

| Fichier JSON | Contenu | Effet |
|---|---|---|
| Rapport d'analyse | notes de révision : pertinence, direction, problème, correction proposée | note sur chaque question, filtres, onglet « Rapport », export des notes à jour |
| Propositions de distracteurs `[{id_origine, probleme, distracteurs_proposes…}]` | distracteurs de remplacement et erreur d'étudiant visée | encadré sur la question, bouton pour les appliquer ou les écarter |
| Titres `[{id_origine, nouveau}]` | nouveaux titres | seul le titre change, l'ancien reste dans l'historique |
| Scores `[{cle, difficulte, temps_min}]` | difficulté de 1 à 5 et temps estimé en minutes | pastille dans la liste, filtre, résumé de l'examen |

Sur une note de révision, la pastille « À corriger » ou « À améliorer » donne l'état ; le bouton
« J'ai corrigé cette question » passe la direction à « Garder », efface le problème et range la
question dans la catégorie de sa pertinence.

## Examens

- Sélection des questions, ordre, total des points, export XML, impression (copie et corrigé).
- **Difficulté et temps** : difficulté moyenne (simple, et pondérée par les points), temps total
  estimé et nombre de questions par niveau. L'en-tête rappelle ces deux valeurs pour l'examen en
  cours pendant la sélection des questions.

La difficulté et le temps se saisissent aussi à la main sur chaque question. Ils restent dans
l'application et dans la sauvegarde des notes : Moodle n'a pas de champ pour eux.

## Assistant Claude

Le bouton **Claude** (en haut) ouvre un panneau de dialogue pour générer de nouvelles questions ou
améliorer la question sélectionnée. Chaque proposition s'affiche en aperçu, avec **Ajouter à la
banque** (comme brouillon) ou **Remplacer la question sélectionnée** (l'ancienne version reste dans
l'historique).

Deux façons de le faire fonctionner, sans rien configurer dans l'application :

- **Claude Code installé et connecté** sur l'ordinateur : l'assistant passe par lui, avec votre
  abonnement. C'est le mode par défaut.
- **Clé d'API Anthropic** : collez-la dans `data_prive/cle_claude.txt` (dossier jamais commité) ou
  dans la variable `ANTHROPIC_API_KEY`. La clé a priorité si elle existe. Le modèle se change avec
  la variable `QR_CLAUDE_MODEL` (par défaut `claude-opus-5-5`).

Confidentialité : seuls vos messages et le texte de la question jointe (case « Joindre la question
sélectionnée ») sont envoyés à Anthropic. Les images et le reste de la banque ne quittent pas
l'ordinateur.

## Données privées et sauvegardes

Les banques de questions réelles vont dans `data_prive/`, ignoré par git, comme tout fichier
`.xml` hors de `tests/fixtures/`. Ne jamais versionner de vraies questions d'examen.

Au lancement, l'application charge d'elle-même les fichiers `.xml` et `.json` posés directement
dans `data_prive/` (les nouveaux et ceux qui ont changé depuis le dernier chargement). Les
sous-dossiers ne sont pas chargés : on peut y ranger des fichiers de travail.

Quelques secondes après chaque modification, l'application écrit une sauvegarde dans
`data_prive/sauvegardes/` : `banque-AAAA-MM-JJ.xml` (toute la banque, réimportable dans
l'application ou dans StudiUM) et `notes-AAAA-MM-JJ.json` (notes de révision, statuts, notes
privées, difficulté et temps, composition des examens). Il y a une sauvegarde par jour, réécrite
au fil de la journée ; les trois derniers jours sont conservés. L'historique des versions et les
propositions de distracteurs ne sont pas sauvegardés.

L'en-tête affiche « Sauvegardé à … ». S'il affiche « Sauvegarde impossible », la fenêtre de
lancement est fermée ou le dossier n'a pas pu être écrit ; la raison s'affiche dans cette fenêtre.

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

Outils en ligne de commande :

- `python -I scripts/nettoyer_mso.py <entrée.xml> <sortie.xml> [rapport.md]` : retire le balisage
  Word / OnlyOffice d'une banque Moodle XML sans toucher au texte ni aux images.
- `QR_XML=<fichier.xml> [QR_OUT=<rapport.txt>] npx vitest run tests/verifier.test.ts` : vérifie un
  fichier Moodle XML avec l'analyseur et les alertes de l'application.

## Niveau cognitif

Chaque question peut porter une étiquette de niveau, qui dit ce que l'étudiant doit faire pour
répondre : `niveau-sait`, `niveau-comprend`, `niveau-sait-comment`, `niveau-applique` ou
`niveau-analyse`. Ce sont de vraies étiquettes Moodle, exportées vers StudiUM. Dans l'application :
pastille dans la liste, filtre « Niveau », menu sur la question, et répartition par niveau dans le
résumé d'un examen. Un fichier JSON `[{cle, niveau}]` s'importe comme les autres.
