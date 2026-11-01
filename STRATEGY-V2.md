# Proposition de stratégie V2 — à évaluer avant activation

Date : 1er novembre 2026.

Choix confirmé par Léo : comparer **20 % et 30 % côte à côte**. Le comparateur
hors ligne est décrit dans [sa documentation](docs/market-comparison.md). Son
premier prix de référence expérimental est le quartile inférieur d’au moins
cinq ventes récentes ; le service V1 conserve ses paramètres d’achat.

Cette note propose une méthode d’évaluation. Elle ne change ni la stratégie
exécutable, ni la fréquence des appels, ni l’activation des achats. La V1 publiée
reste en simulation par défaut, avec une seule position et un plafond de 3 500 WB.

## Objectif

Repérer aussi des occasions moins évidentes, avec une décote plus modeste mais
étayée, puis mesurer si elles subissent moins de concurrence. Comparer leur marge
prudente et leur liquidité. Le nombre d’enchères gagnées ne suffit pas à mesurer
la réussite : une enchère perdue au-dessus de notre plafond évite un mauvais achat.

Léo rapporte deux difficultés : repérer rapidement les occasions, et réagir à
des mises tardives lorsque le bouton devient grisé ou ne répond plus. Il souhaite
reconsidérer le filtre à moitié prix, qui pourrait concentrer la sélection sur
les mêmes annonces que les autres acheteurs. Cette explication est une hypothèse
à tester : les critères des autres comptes ne sont pas connus.

La proposition compare donc des décotes minimales de 20 %, 30 % et 50 %. Les
limites d’une seule position et de 3 500 WB par carte sont conservées. Aucun de
ces nouveaux seuils n’est appliqué au code publié par cette note.

L’observation de comptes très actifs ne prouve pas qu’ils sont automatisés, ni
que l’automatisation est autorisée. Le règlement interdit explicitement les
bots, l’exploitation de bogues et le contournement des limites techniques.
Le refus `automation_limit` déjà observé reste un signal concret. Aucun essai
de contournement ou de perturbation des mises concurrentes n’entre dans ce plan.

Source : [règles officielles](https://www.wiki-masters.com/rules), consultées le
1er novembre 2026.

## Faiblesses de la V1

1. **Couverture limitée.** Le service `market-run` peut rester lancé en continu,
   mais il ne lance qu’un repérage par heure. Il sélectionne des fins entre
   30 et 120 secondes. Sous l’hypothèse simplificatrice de fins uniformément
   réparties, cette fenêtre représente 90 / 3 600 = 2,5 % des échéances. La
   pagination et le temps de lecture modifient la couverture effective.
   Ce calcul n’est pas une mesure du marché réel.
2. **Référence fragile.** Trois ventes peuvent suffire actuellement ; une moyenne
   peut être déformée par une vente atypique, des variantes mélangées, des
   statistiques d’exemplaires différentes ou une évolution récente de la demande.
3. **Liquidité non estimée.** Le plus grand écart en WB peut concerner une carte
   lente à revendre. Un prix historique élevé ne garantit pas un acheteur actuel.
4. **Historique incomplet pour mesurer les échecs.** Un endpoint ne donnant que
   les ventes conclues ne permet pas d’estimer, à lui seul, la proportion de
   cartes vendues en une heure. Il faut aussi observer les invendus.
5. **Filtre de prix très restrictif.** Le plafond actuel à 50 % de la moyenne
   exclut les décotes plus modestes. Il ne mesure pas la concurrence sur les
   annonces retenues.
6. **Suivi tardif possible.** Le suivi interroge les données toutes les 15 secondes
   par défaut. Une mise adverse acceptée à 11 secondes de la fin peut survenir
   entre deux lectures et n’être observée qu’après la clôture. C’est une limite
   de la V1, distincte du problème rencontré manuellement dans le navigateur.

## Chaîne de décision proposée

### 1. Restreindre l’univers aux cartes suffisamment documentées

Conserver les préférences déjà fixées : légendaires, image présente, exclusion
des shiny lorsque l’historique ne permet pas de les comparer correctement.
Identifier un ensemble de cartes ayant des ventes récentes et des prix assez
stables. La présence d’une image reste une préférence, pas une preuve de demande.

Comparer la même carte et la même rareté, puis la variante et les statistiques
si les données existent. Conserver un indicateur explicite de comparabilité
inconnue. Un manque de données conduit à « non évaluable », pas à une estimation
présentée comme fiable.

Tester des seuils d’échantillon de 5 et de 10 ventes, avec plusieurs fenêtres
historiques. Ce sont des hypothèses de recherche : aucun seuil n’a encore été
validé sur les opérations réelles du compte.

### 2. Construire une référence de sortie prudente

Comparer la moyenne actuelle avec la médiane et le quartile inférieur des prix
de ventes comparables récentes. Vérifier leur dispersion et l’écart entre prix
récents et anciens. Un quartile bas peut servir d’hypothèse de prix de sortie ;
il ne garantit pas une revente à ce prix.

Les éventuels frais doivent être observés avant tout calcul de marge nette.
Une variation globale du portefeuille n’est pas une preuve de frais lorsqu’il
contient plusieurs mouvements simultanés.

### 3. Comparer des décotes plus modestes avec les mêmes limites de budget

Pour chaque seuil testé :

```text
plafond = minimum de :
  3 500 WB
  solde disponible moins la réserve choisie
  (1 - décote minimale) × prix de sortie prudent
  prix de sortie prudent moins les frais vérifiés et la marge WB minimale choisie
```

Une décote minimale de 20 % autorise donc au plus 80 % du prix de sortie prudent ;
30 % en autorise 70 %. Les frais et la marge WB minimale restent à déterminer.
Un résultat avant frais n’est pas présenté comme une marge nette.

Le prix comparé reste la prochaine mise autorisée, avec son incrément, et non
le prix affiché avant cette mise. Le plafond est fixé avant la première mise et
ne monte pas pour répondre à un concurrent. Les décotes plus fortes restent
évaluées avec les mêmes exigences de comparabilité et de concurrence.

Exemple fictif avant frais : une prochaine mise de 2 500 WB et une sortie
prudente supposée à 3 200 WB laissent 700 WB d’écart, soit 21,9 % de décote.
Avec le seuil de 20 %, le plafond est de 2 560 WB. La mise suivante minimale
après 2 500 WB serait de 2 750 WB : elle dépasserait déjà le plafond.

L’incrément d’environ 10 % limite donc fortement le nombre de réponses possibles
lorsque la décote de départ est petite. Gagner plus souvent et conserver une
marge suffisante sont deux résultats à mesurer séparément.

### 4. Filtrer la demande et observer la concurrence avant de classer

Exiger d’abord une référence suffisamment fiable et une activité de vente
observable. Peu d’enchérisseurs ne prouve pas qu’une carte soit une bonne affaire :
cela peut aussi traduire une absence de demande.

La préférence acceptée reste le plus grand écart en WB parmi les candidats
retenus. À marge comparable, évaluer une préférence pour les enchères moins
disputées. Tester séparément un filtre excluant les annonces déjà très disputées,
avec un seuil explicite à calibrer. Ce filtre modifierait l’univers de sélection.

La rotation du capital reste un critère secondaire à documenter, puisque le
compte ne finance qu’une position à la fois jusqu’à sa revente confirmée.

### 5. Comprendre la concurrence

Sur des observations accessibles normalement, relever le nombre de
soumissionnaires, le prix final et la fréquence des dépassements de notre
plafond. Comparer ces mesures par carte, tranche de prix et créneau horaire.
Il n’est pas nécessaire de désigner des comptes comme « bots » pour cela.

Le nombre de soumissionnaires distincts décrit uniquement l’historique visible
au moment du choix. Il ne prédit pas les arrivées de dernière minute. Conserver
la portée et l’heure de cette observation ; une valeur inconnue reste inconnue.

Les observations se font sans mises de sondage. La latence mesurée reste un
indicateur opérationnel ; elle ne donne pas l’heure exacte d’arrivée serveur.

### 6. Améliorer le repérage à partir d’un accès permis

Étudier un repérage plus en amont et un suivi d’un ensemble restreint de cartes
connues. Le volume et la fréquence de données nécessaires doivent être
compatibles avec l’accès autorisé. Le plan ne suppose aucun nouveau flux API
officiel, aucune hausse autorisée de cadence ni aucune permission du site.

Les premières comparaisons peuvent se faire sur des exports ou observations
manuels. Une collecte refusée reste arrêtée. Le service n’est pas passé en
activité de marché continue sur la base de la présence d’autres comptes actifs.

## Réactivité et bouton grisé : faits et diagnostic

Dans le client public récupéré, le bouton de mise est désactivé lorsqu’une
requête de mise est en cours, ou lorsque le montant saisi est inférieur au
minimum calculé. Pendant la requête, son libellé devient « … ». Le gestionnaire
attend la réponse et son corps JSON avant de quitter cet état ; cet appel ne
définit pas de délai maximal applicatif explicite.

Léo confirme que le bouton affiche « … » pendant son blocage. Cela correspond
à l’état d’attente du traitement de la mise côté client. Cela ne localise pas
la cause du délai entre réseau, serveur et lecture de la réponse, et ne prouve
pas que la mise a été acceptée ou refusée. Vérifier son résultat avant toute
nouvelle tentative reste nécessaire.

Le client reçoit normalement des notifications `BID`, met à jour le prix et
l’échéance, puis préremplit le nouveau montant minimal. Il serait donc incorrect
d’affirmer que le champ reste systématiquement à l’ancienne valeur après une
surenchère. Le code observé ne démontre aucun verrou spécial à 11 secondes.

Le texte de l’interface annonce une prolongation de 60 secondes pour une mise
dans les dix dernières secondes. Cette annonce ne prouve ni son application
effective côté serveur dans chaque cas, ni l’existence du bogue rapporté.

Source primaire : [client public de détail d’enchère](https://www.wiki-masters.com/_next/static/chunks/0rsbvuecogus-.js).

Piste technique pour une V2 : étudier le suivi des notifications normales de
l’enchère, plutôt que d’attendre uniquement la prochaine lecture à 15 secondes.
L’accès et le comportement exact du flux restent à valider. Une notification
déclencherait une réévaluation du prix, du portefeuille et du temps disponible,
dans les limites existantes, avec une seule requête de mise en cours. Une perte
de connexion serait explicite ; aucun fonctionnement en temps réel ne serait
annoncé lorsque le flux est absent.

Les journaux proposés distinguent : réception de la surenchère et sa source,
échéance connue, prochain minimum, plafond, lecture du portefeuille, attente
entre appels, départ de la requête et réponse reçue ou résultat incertain.
Mesurer toute cette chaîne est plus utile que le seul aller-retour du POST.
Ces mesures ne donnent pas l’instant exact d’acceptation par le serveur. Aucun
envoi visant à perturber les autres joueurs, ni nouvelle tentative automatique
après une réponse ambiguë, ne fait partie de cette proposition.

## Données nécessaires

Pour chaque occasion évaluée, conserver le prix proposé, les comparables et
leur date, la méthode de référence, la décote, le plafond, la concurrence visible
et la justification du choix/rejet. Ajouter le prix final si connu.
Pour chaque achat, conserver le prix payé, les annonces de revente associées,
les invendus, le délai jusqu’à une vente confirmée et les frais vérifiés.

Les observations non terminées restent identifiées comme telles. Une carte
encore en stock n’est ni un gain réalisé ni une perte totale certaine. Ne pas
écarter ces positions du bilan pour embellir les résultats.

## Comparaison hors ligne

Comparer sur le même ensemble d’occasions :

- A : règle actuelle, seuil de 50 % et plus grand écart à la moyenne ;
- B : référence prudente et filtre de demande, décote minimale de 50 % ;
- C : mêmes paramètres que B, décote minimale de 30 % ;
- D : mêmes paramètres que B, décote minimale de 20 %.

Conserver d’abord le classement en WB pour isoler l’effet du seuil. Comparer
ensuite, séparément, l’ajout d’un filtre de concurrence et d’une préférence pour
les ventes moins disputées à marge comparable. Les seuils proposés ne sont pas
des résultats de marché déjà démontrés.

Calibrer les paramètres sur une période passée, puis les évaluer sur une autre
période plus récente, sans utiliser d’information future au moment du choix.
Inclure les coûts d’incrément, les refus de données et les invendus. Une
simulation sans participation ne permet pas de déduire avec certitude qui
aurait gagné si le bot avait lui-même changé le déroulement des mises.

Mesures à comparer : nombre d’occasions évaluables, concurrence observée,
proportion de clôtures sous notre plafond, puis, pour de vraies opérations,
marge réalisée après frais connus, proportion d’invendus, durée médiane et haute
d’immobilisation et capital maximal engagé. Une clôture sous le plafond dans
une observation passive n’est pas une victoire simulée garantie.

La V2 n’est activable qu’après une amélioration observée sur une période séparée
et une validation des nouveaux critères. À ce stade, aucune supériorité face
à d’autres joueurs ou programmes n’est démontrée.
