# Comparer des décotes de 20 % et 30 %

Cet outil hors ligne applique les deux seuils au **même instantané**, avec le
même portefeuille, les mêmes ventes historiques et le même classement par écart
en WB. Chaque scénario retient au plus une carte ; leurs montants ne s’additionnent
pas. Le plafond de 3 500 WB et la réserve du portefeuille restent contraignants.

## Démonstration

```bash
npm run market:compare -- --demo
```

Ou dans l’image reconstruite :

```bash
sudo docker compose run --rm wiki-bot market-compare --demo
```

Les données sont **fictives**. Le scénario à 20 % choisit une carte à 3 100 WB
contre une référence de 4 000 WB (écart brut de 900 WB). Celui à 30 % la refuse
et retient une carte à 1 600 WB contre 2 400 WB (écart brut de 800 WB).
Ce résultat vérifie le fonctionnement, pas la performance sur le marché.

Voir le [rapport de démonstration](market-comparison-demo.md) et le
[fichier d’exemple](market-comparison-example.json).

## Comparer des observations enregistrées

```bash
node src/index.mjs market-compare /chemin/instantane.json
node src/index.mjs market-compare /chemin/instantane.json --json
```

Le fichier JSON suit le format de l’exemple :

- `schemaVersion: 1` et `source: "saved_snapshot"` ;
- `observedAt` : date ISO de l’observation, avec fuseau ;
- `account` : `userId`, `balance`, `positionOccupied` et éventuellement `reserveWB` ;
- `auctions` : annonces enregistrées, au format de la réponse marketplace ;
- `salesByCard` : objet associant chaque `card_id` à son tableau de ventes.

Le fichier est limité à 8 Mio et 1 000 annonces, avec identifiants uniques.
`positionOccupied` doit être vrai si le compte suit déjà une position, y compris
une carte achetée en attente de revente. Une enchère active déjà menée, lorsqu’elle
figure dans le fichier, bloque également un nouveau choix. Les données du compte
doivent correspondre à l’instant de l’observation ; leur exactitude et leur
exhaustivité ne peuvent pas être vérifiées hors ligne.

L’outil ne télécharge aucun historique : un historique absent ou trop court
produit un rejet explicite. Il ne lit pas de session ni de portefeuille actuel.
Il n’envoie pas de requête, ne crée pas d’état de suivi et ignore les réglages
live de l’environnement. Les paramètres du service d’achat restent ceux de la V1.

## Référence et comparaison

La référence commune est le quartile inférieur empirique : après tri croissant,
prendre la valeur de rang `ceil(n/4)` (rangs commençant à 1). Au moins cinq ventes
sont requises ; au plus les dix dernières ventes comparables sur 30 jours sont
retenues. Les ventes postérieures à `observedAt`, doublons, autres cartes/raretés,
invendus et variantes explicitement shiny sont exclus. Le rapport signale les
variantes inconnues ; les statistiques exactes des exemplaires ne sont pas
garanties comparables. Ce choix de référence est une hypothèse à évaluer.

Le plafond est le minimum de 3 500 WB, du solde moins la réserve, et de 80 %
(scénario à 20 % de décote) ou 70 % (scénario à 30 %) de cette référence, arrondi
vers le bas. Le prix comparé inclut le prochain incrément autorisé. Le filtre
L, image présente, variante non shiny et fenêtre de 30 à 120 secondes est commun.

Pour chaque annonce, le rapport indique son admissibilité, les motifs de rejet,
sa référence et l’échantillon utilisé. La sortie JSON ajoute la prochaine mise,
le plafond, l’écart et le rang lorsqu’ils sont calculables. Les scénarios partagent
le classement par écart absolu, puis décote, échéance et identifiant stable.

Les résultats sont avant frais. La concurrence, les futures contre-enchères,
la liquidité et les délais de revente ne sont pas modélisés. Cette comparaison
ne déclare ni gagnant hypothétique ni bénéfice réalisé. Des observations réelles
restent nécessaires pour évaluer l’intérêt des deux seuils.
