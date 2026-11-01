# Première version du suivi d’achats

Les paquets restent en veille. Le marché dispose de commandes séparées et démarre
en **simulation**. La livraison ne lance aucun achat sur le compte.

## Règles de sélection

| Critère | Première version |
| --- | --- |
| Cartes | Légendaires L avec une image non masquée |
| Variante | Shiny exclues pour éviter de mélanger leurs prix |
| Temps au premier choix | Entre 30 et 120 secondes restantes |
| Référence | Moyenne arrondie des 10 dernières ventes de cette carte en L, sur 30 jours |
| Échantillon minimum | 3 ventes conclues récentes ; sinon rejet explicite |
| Plafond | Minimum de 3 500 WB, 50 % de la référence et du solde disponible moins la réserve |
| Prix comparé | Prochaine mise autorisée, avec l’incrément ; pas seulement le prix affiché |
| Classement | Plus grand écart en WB entre la référence et la prochaine mise |
| Égalité | Meilleure décote en %, puis fin la plus proche, puis identifiant stable |
| Positions | Une seule, depuis la première mise jusqu’à la revente confirmée |
| Recherche | Au plus une fois par heure, délai conservé après redémarrage |

Exemple : référence 1 000, prochaine mise 300 → écart 700 WB. Référence 6 000,
prochaine mise 2 800 → écart 3 200 WB. Le deuxième choix passe en premier.
L’écart est une estimation avant d’éventuels frais ; il ne garantit ni une vente
ni un bénéfice. La moyenne peut être influencée par des ventes atypiques.

Ces seuils de prix, durée et historique sont configurables. Les bornes de la V1
interdisent de dépasser 3 500 WB ou 50 % de la référence. Une carte gagnée mais
invendue garde la place occupée. Il n’y a pas de plafond journalier fixe : le
solde serveur et la place disponible contrôlent les nouveaux engagements.

L’historique observé dans le client est filtré par carte et rareté. Il peut ne
pas donner les statistiques de chaque exemplaire ni son caractère shiny. Le
journal conserve `scope: same_card_and_rarity` et `variantUnknownCount` pour
rendre cette limite visible. Les ventes explicitement shiny sont exclues.
Cette référence ne constitue donc pas une comparaison garantie entre exemplaires
de statistiques identiques. Le filtre d’image vérifie sa présence, pas sa qualité.

Le repérage est borné par défaut à 5 pages de 50 annonces et 10 lectures de
nouveaux historiques. Les doublons de pages sont éliminés. Les historiques sont
mis en cache 6 heures puis les dates de vente sont refiltrées à chaque usage.
Un marché mouvant peut modifier la pagination pendant la recherche. Les journaux
signalent les limites atteintes et les cartes non évaluées ; le classement porte
sur les occasions effectivement évaluées.

## Vérifier la livraison sans contacter le site

La comparaison hors ligne des seuils de **20 % et 30 % de décote** dispose de sa
[commande et de son format d’instantané](docs/market-comparison.md). Elle utilise
la même base de prix prudente dans les deux scénarios et garde le classement en
WB. Ces seuils expérimentaux ne modifient pas le plafond à 50 % du service V1.

Après récupération du code et reconstruction de l’image :

```bash
sudo docker compose run --rm wiki-bot market-demo
```

Cette démo utilise uniquement des données fictives. Elle montre le choix entre
deux cartes, un rejet sans image, une contre-mise proposée, une prolongation,
l’arrêt au plafond et le résultat observé. Elle ne charge aucun navigateur et
n’envoie aucune requête. Exemple de sortie : [journal de démo](docs/market-demo.md).

## Faire un repérage en simulation sur le compte

Arrête d’abord l’ancien service pour ne pas utiliser le profil Chromium à deux :

```bash
sudo docker compose stop wiki-bot
```

Conserve ces réglages dans `.env` :

```dotenv
PACK_OPENING_ENABLED=false
MARKET_MODE=simulation
MARKET_LIVE_ENABLED=false
MARKET_MAX_PER_CARD=3500
MARKET_RANK_BY=saving
```

Lance une recherche puis le suivi de l’occasion sélectionnée jusqu’à sa clôture :

```bash
sudo docker compose run --rm wiki-bot market-once
sudo docker compose run --rm wiki-bot market-report
```

La simulation suit l’enchère réelle et décrit les mises qu’elle proposerait.
Elle ne peut pas prédire le gagnant d’une enchère à laquelle ces mises fictives
auraient participé. Un montant refusé par le budget n’est jamais envoyé.
La simulation effectue des lectures du site et peut elle aussi être refusée.

La session provient du profil privé déjà sélectionné par `use-manual-session`
ou du profil habituel. Aucun cookie ou jeton n’est copié dans les logs ou dans
le dépôt. Si le compte n’a ni vente ni achat passé permettant de l’identifier,
`MARKET_USER_ID` peut fournir son UUID. Une incohérence de compte provoque l’arrêt.
Une enchère manuelle que vous menez déjà empêche la sélection d’une nouvelle carte.

## Service horaire

Après examen des logs de simulation, `BOT_MODE=market-run` dans `.env` sélectionne
le service du marché. `BOT_MODE=run` garde les paquets en veille.

```bash
sudo docker compose up -d --build --force-recreate wiki-bot
sudo docker compose logs -f --tail=100 wiki-bot
```

Le repérage reste horaire. Un suivi engagé continue entre les recherches, avec
une lecture toutes les 15 secondes par défaut. Les appels sont séquentiels,
espacés d’au moins 2 secondes, avec délai maximal de 10 secondes. Aucun retry
réseau ou HTTP automatique n’est activé. Le navigateur reste sur une page vide :
les lectures passent par le contexte de requêtes associé au profil existant.

## Achat réel et déroulement d’une enchère

Le chemin d’achat est implémenté, mais n’a pas été testé par une transaction
réelle pendant le développement. Pour un lancement réel ultérieur, il faut
explicitement régler **les deux** variables `MARKET_MODE=live` et
`MARKET_LIVE_ENABLED=true`. Les autres critères et plafonds continuent de
s’appliquer. La configuration livrée garde `simulation` et `false`.

Avant la première mise, le détail et le portefeuille sont relus. Le plafond de
la position est ensuite figé ; une modification de configuration peut le réduire,
jamais le relever. Une mise que le compte mène déjà n’est pas augmentée.
Après une surenchère adverse, le solde est relu : les mises sont débitées tout
de suite par le site puis remboursées lorsque le compte est surenchéri. Le bot
ne soustrait donc pas une deuxième fois les mises déjà débitées.

Le client officiel utilise `max(ceil(1.1 × mise actuelle), mise actuelle + 1)`
pour la prochaine mise. Si le serveur refuse parce que ce minimum vient de
changer, le bot conserve le nouveau minimum et attend le suivi suivant ; il
ne renvoie pas immédiatement une mise. Toute hausse doit rester sous le plafond.

Une mise dans les 10 dernières secondes prolonge la fin de 60 secondes. Le bot
relit la date serveur. Il ne tente pas délibérément de contre-mise quand il reste
moins que la marge de requête (5 secondes avec les réglages par défaut).
La limite de 30 secondes sert à la sélection initiale ; une position existante
peut être suivie et contre-enchérie plus tard.

Si le plafond est dépassé ou les fonds sont insuffisants après une surenchère,
le bot arrête de miser mais continue de lire le résultat final. Une date de fin
dépassée ne signifie pas à elle seule que la carte a été gagnée : le bot attend
le statut de règlement du serveur. Après 30 minutes de suivi sans résultat, il
se met en pause et conserve la position pour vérification.

## Logs et diagnostic

Chaque requête existante mesure son aller-retour côté bot avec une horloge
monotone. Une mise confirmée journalise `requestStartedAt`, `responseReceivedAt`
et `roundTripMs`. La première mesure de la position est conservée, les suivantes
indiquent leur variation ; le minimum, maximum et la médiane portent sur les
20 dernières mises confirmées dans la session. Aucune requête de sondage n’est
ajoutée pour mesurer ces délais.

Cet aller-retour inclut le transport et le traitement serveur. Il ne mesure pas
le délai aller seul et ne permet pas de connaître l’instant exact d’arrivée
au marché. La V1 n’en déduit aucune heure de mise et n’ajoute pas de stratégie
visant un dysfonctionnement du site à 11 secondes restantes.

```bash
sudo docker compose run --rm wiki-bot market-status
sudo docker compose run --rm wiki-bot market-report
```

Les logs JSON ont un nom d’événement stable et une phrase explicative. Ils
conservent le prix proposé, la moyenne, le nombre de ventes, le plafond, l’écart,
la décote, les raisons de rejet, les prolongations et l’issue observée. Le rapport
les rassemble en tableau et résume les motifs de rejet.

Les données se trouvent dans le volume privé, sous
`/data/market/simulation/state/` ou `/data/market/live/state/` : `events.jsonl`,
`book.json`, `references.json` et éventuellement `paused.json`. Le rapport affiche
les 500 derniers événements. Les corps bruts d’erreur, cookies et jetons ne sont
pas journalisés.

| Événement ou code | Comportement |
| --- | --- |
| `candidate_rejected` | Critère de rejet explicite, sans mise |
| `candidate_selected` | Choix, comparaison des candidats, référence et plafond |
| `would_bid` | Proposition de simulation, aucun POST |
| `bid_confirmed`, `outbid`, `auction_won`, `auction_lost` | Déroulement réel et résultat confirmé |
| `automation_limit`, HTTP 429, `access_denied` | Pause persistante ; aucun nouvel essai |
| `human_verification_required` ou réponse non JSON | Pause ; intervention manuelle, aucun traitement du challenge |
| `pro_required` | Historique inaccessible ; aucune référence inventée et pause |
| `login_required` | Reconnexion manuelle nécessaire |
| Erreur réseau / serveur pendant une mise | Intention conservée ; résultat incertain, aucun renvoi automatique |

Après un blocage, le contexte navigateur est fermé et la pause persiste au
redémarrage. Arrête le service, vérifie la situation manuellement, puis utilise
`market-resume` uniquement lorsque le problème est réglé. La commande `resume`
des paquets est distincte et ne lève pas la pause du marché.

Une mise interrompue garde une intention durable avant le POST. Pour la vérifier :

```bash
sudo docker compose stop wiki-bot
sudo docker compose run --rm wiki-bot market-reconcile
```

Cette commande lit le serveur, sans envoyer de mise. Si la situation reste
ambiguë, elle refuse de libérer l’intention. Après une réconciliation suffisante :

```bash
sudo docker compose run --rm wiki-bot market-resume
```

Un verrou empêche deux commandes de suivi d’écrire simultanément. Un arrêt brutal
peut laisser ce verrou. Après avoir arrêté tous les conteneurs qui utilisent ce
volume, la récupération explicite est `market-unlock --stopped`. Elle n’efface
ni la pause ni les intentions de mise.

## Revente et trésorerie

Cette version ne crée pas de vente. Une carte réellement gagnée garde sa place
occupée jusqu’à sa revente confirmée. Après une mise en vente manuelle, rattache
l’identifiant de la vente à l’achat, service arrêté :

```bash
sudo docker compose run --rm wiki-bot market-link-sale UUID_ACHAT UUID_REVENTE
```

Le bot vérifie le vendeur, la carte, la rareté et une création postérieure au
gain. Il s’agit d’une correspondance de carte/rareté ; si vous avez plusieurs
exemplaires identiques, choisissez vous-même la bonne annonce de revente.
Il attend la confirmation `settled_sold` avant de libérer la place. Une revente
annulée ou sans acheteur garde la carte immobilisée. Le prochain achat relira
le portefeuille. L’écart brut de revente est journalisé séparément d’un bénéfice
net, les éventuels frais n’ayant pas été vérifiés.

## Sources et validation

Les routes et règles ont été retrouvées dans le code public du site le
31 octobre 2026, sans envoyer d’enchère :

- [Client de détail d’enchère](https://www.wiki-masters.com/_next/static/chunks/0rsbvuecogus-.js)
- [Client d’historique des ventes](https://www.wiki-masters.com/_next/static/chunks/0~r~p2xs9m7lk.js)
- [Contexte de requêtes Playwright et cookies partagés](https://playwright.dev/docs/api/class-apirequestcontext)

`npm test` utilise des réponses fictives pour les achats et les refus. Aucun
achat réel n’est exécuté par les tests ou par la démo. La construction complète
de l’image et le fonctionnement de l’API depuis le VPS restent à vérifier sur
cet environnement.
