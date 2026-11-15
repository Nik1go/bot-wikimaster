# Bot de tri de collection (C / PC / R par défaut)

Ce bot ouvre les cartes une à une dans la collection, puis la vue « Marché ».
Il ajoute l’étiquette **à vendre** uniquement si la **moyenne affichée est > 50 WB**
et le **compteur Ventes est > 80**, pour **la même rareté que l’exemplaire détenu**.
50 WB exactement ou 80 ventes exactement ne suffisent pas. Ces seuils sont réglables.

Il lit la moyenne du graphique du site et le nombre de ventes affiché : ce n’est
pas une mesure de ventes par jour ni une garantie de revente rapide. Le site
affichait par exemple 200 ventes sur une carte lors de la vérification du
14 novembre 2026 ; ce chiffre décrit l’historique chargé par le site.

Par défaut, il filtre C, PC et R, force le tri Rareté, parcourt chaque page et chaque
exemplaire, y compris les doublons. Dans le marché, il active la rareté détenue,
relit la sélection après chaque clic et désactive seulement les autres raretés
encore sélectionnées, puis vérifie la sélection et l’en-tête des ventes
avant de lire Ventes/Moyenne. Il gère l’onglet Marché observé le 14 novembre 2026
et le bouton accessible « Vue du marché » pour l’ouverture de cette vue.
Une rareté impossible à confirmer provoque une pause explicite.

Le marché observé utilise un filtre exclusif « Toutes / Rare / Super Rare… » :
cliquer sur Rare désactive Toutes automatiquement. Le bot gère aussi une interface
à sélection multiple. Il ne reclique jamais sur Toutes à partir d’un ancien état.

L’action est un **ajout d’étiquette**. Les autres étiquettes et les favoris sont
conservés. Aucune enchère, vente, défausse ou ouverture de paquet n’est déclenchée.
Une carte admissible déjà étiquetée est laissée telle quelle.

Après un ajout, le bot attend la fin de l’enregistrement, recharge la collection,
revient à la même page et vérifie la même carte et son étiquette. Un simple badge
apparu à l’écran ne suffit pas. La confirmation fonctionne aussi lorsque le site
enregistre hors d’un chemin `/api/`. En cas d’échec, aucun second clic n’est envoyé.
`collection_label_verified` confirme cette relecture ; le journal conserve seulement
la méthode, l’adresse sans paramètres et le statut des requêtes, sans cookies ni contenu.

## Déployer sur ton VPS existant

Utilise le **dossier Compose actuel du VPS** : son nom détermine le volume où
ta session est conservée. Dans les exemples, il s’appelle `bot-wikimaster`.
Adapte le chemin, l’utilisateur SSH et l’adresse du VPS.

Le code se récupère depuis ton dépôt [Nik1go/bot-wikimaster](https://github.com/Nik1go/bot-wikimaster),
sur la branche `main`. Connecte-toi au VPS comme d’habitude, puis, dans le dossier existant :

```bash
cd ~/bot-wikimaster
# Arrête le bot existant : le profil de navigateur sera partagé.
sudo docker compose stop
# Si le service collection était déjà installé :
# sudo docker compose -f compose.yaml -f compose.collection.yaml stop wiki-collection

git pull --ff-only origin main
# Si tu n’avais pas encore de fichier .env :
test -f .env || cp .env.example .env
sudo docker compose build
sudo docker compose -f compose.yaml -f compose.collection.yaml config --quiet
```

Git met à jour les sources et les guides ; ton `.env` et le volume Docker de
connexion sont conservés. Si Git signale une divergence ou des modifications
locales, examine-les avant de continuer, sans forcer leur écrasement.
Docker et Compose v2 doivent déjà être installés.

Les services `wiki-bot` et `wiki-collection` utilisent maintenant la même image
locale `wiki-masters-bot:local` et le même volume de connexion. Reconstruire
`wiki-bot` met donc aussi à jour le code exécuté par `wiki-collection`.

## Se connecter à ton compte

Si le bot existant possède encore une session valide dans son volume, cette
connexion peut être réutilisée, y compris le profil sélectionné par
`use-manual-session`. Sinon, lance sur le VPS :

```bash
sudo docker compose run --rm --service-ports wiki-bot collection-login
```

Laisse cette commande active. Dans un **deuxième terminal de ton PC** :

```powershell
ssh -N -L 6080:127.0.0.1:6080 utilisateur@adresse-du-vps
```

Ouvre [le navigateur distant](http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale).
Connecte-toi à WikiMasters, attends de voir ta collection, puis fais **Ctrl+C
dans le terminal qui exécute collection-login**. Le profil reste dans le volume
Docker. La connexion faite dans Edge sur ton PC est distincte de celle du VPS.

Une vérification humaine se traite dans ce navigateur. Si le site refuse la
connexion, le bot enregistre le refus et s’arrête ; il ne tente pas de le contourner.
N’utilise jamais `docker compose down -v` pour une mise à jour : cela supprime le volume.

## Lancer la production après validation locale

Les tests se font en local, selon les sections ci-dessous. Le VPS exécute ensuite
le parcours de production. Ouvre `.env` sur le VPS :

```bash
nano .env
```

Ajoute ou règle ces lignes, puis enregistre :

```dotenv
PACK_OPENING_ENABLED=false
COLLECTION_APPLY=true
COLLECTION_MIN_AVERAGE=50
COLLECTION_MIN_SALES=80
COLLECTION_RARITIES=C,PC,R
COLLECTION_DELAY_SECONDS=3
COLLECTION_TIMEOUT_SECONDS=30
```

Lance le service dédié :

```bash
sudo docker compose -f compose.yaml -f compose.collection.yaml up -d --build wiki-collection
sudo docker compose -f compose.yaml -f compose.collection.yaml logs -f --tail=50 wiki-collection
```

Ctrl+C quitte l’affichage des logs ; le service reste actif. Il conserve la
progression d’un passage précédent. Une fois le parcours terminé,
il ferme le navigateur et reste en veille. Il ne recommence pas automatiquement.
Évite de modifier la collection pendant le parcours : ouvertures, ventes et
défausses peuvent changer l’ordre des cartes et imposer un nouveau parcours.
À 3 secondes de pause, 10 000 cartes représentent déjà 8 h 20 de pauses,
auxquelles s’ajoutent les chargements et l’étiquetage.

## Lire les logs et diagnostiquer un blocage

Les réglages suivants se modifient dans `.env` sur le VPS :

| Variable | Exemple | Effet |
| --- | --- | --- |
| `COLLECTION_MIN_AVERAGE` | `50` | Moyenne du bon marché strictement supérieure à 50 WB |
| `COLLECTION_MIN_SALES` | `80` | Nombre de ventes strictement supérieur à 80 |
| `COLLECTION_RARITIES` | `C,PC,R` | Raretés à parcourir, séparées par des virgules |
| `COLLECTION_APPLY` | `false` | Simulation ; `true` active l’ajout d’étiquettes |
| `COLLECTION_DELAY_SECONDS` | `3` | Pause entre deux cartes |
| `COLLECTION_TIMEOUT_SECONDS` | `30` | Délai maximal d’attente d’une étape |

Codes acceptés : `C` (Commun), `PC` (Peu commun), `R` (Rare), `SR` (Super Rare),
`UR` (Ultra Rare), `L` (Légendaire). Par exemple `COLLECTION_RARITIES=R` cible
seulement les Rares, et `COLLECTION_RARITIES=R,SR` cible Rares et Super Rares.
Si la variable est absente d’un ancien `.env`, `C,PC,R` reste le défaut.

Après un changement de prix, de nombre de ventes ou de raretés, arrête le service,
puis utilise `collection-resume --fresh` pour préparer un parcours avec les
nouveaux critères, avant de recréer le service. Cette commande ne lance aucun
navigateur et ne traite aucune carte. Les étiquettes déjà ajoutées restent présentes.
Les commandes lancées avec
`docker compose run` lisent le `.env` actualisé. La mise à jour du bot conserve
une progression C/PC/R existante si ces trois critères restent identiques.

Exemples de lignes de console :

```text
collection_page | Page 4/190 : 12/50 cartes déjà vérifiées.
collection_card | Exemple [PC] : ouverture du marché.
collection_result | Exemple [PC] : moyenne 63 WB, 120 ventes ; étiquette ajoutée (les deux seuils sont dépassés).
collection_heartbeat | En cours : page 4, carte 14, Exemple [R], étape market.
collection_paused | Lecture refusé : HTTP 429, /api/... Intervention nécessaire avant reprise.
collection_complete | Toutes les cartes C, PC et R ont été vérifiées.
```

Un message de suivi apparaît toutes les 30 secondes pendant le parcours. Les
étapes sont `opening`, `market`, `label` et `simulation`. Les raisons de rejet
sont `no_sales`, `average_too_low` et `not_enough_sales`. Les actions sont
`skipped`, `would_tag`, `tagged` et `already_tagged`.

Pour lire l’état et les candidates pendant que le service tourne :

```bash
sudo docker compose -f compose.yaml -f compose.collection.yaml exec wiki-collection node src/index.mjs collection-status
sudo docker compose -f compose.yaml -f compose.collection.yaml exec wiki-collection node src/index.mjs collection-report
```

Les fichiers se trouvent dans le volume, sous `/data/collection/apply/state/`
(ou `simulation/state/`) :

| Fichier | Contenu |
| --- | --- |
| `events.jsonl` | Journal structuré, une ligne par événement et résultat de carte |
| `progress.json` | Pages contrôlées, position, seuils, compteurs, fin du parcours |
| `current.json` | Dernière carte et étape en cours |
| `paused.json` | Cause et position du blocage |
| `pause.png` | Capture du navigateur lors du blocage, si disponible |

Pour récupérer la capture :

```bash
sudo docker compose -f compose.yaml -f compose.collection.yaml cp wiki-collection:/data/collection/apply/state/pause.png ./collection-pause.png
```

Les logs affichent des heures UTC. `collection-report` affiche les candidates
du parcours courant, avec leur prix, leur rareté, leur position et leur action.
Une moyenne manquante n’est jamais remplacée par zéro ou une autre rareté.

La ligne `collection_market_rarity` confirme la rareté isolée. En cas d’échec,
le diagnostic indique la carte, les boutons encore sélectionnés et l’en-tête
de l’historique réellement affiché.

## Arrêter et reprendre

```bash
sudo docker compose -f compose.yaml -f compose.collection.yaml stop wiki-collection
```

Après Ctrl+C ou un arrêt normal, relance le même parcours : la progression est
conservée après chaque carte. Si l’arrêt survient pendant l’ajout d’étiquette,
la carte est revérifiée ; une étiquette déjà présente n’est pas basculée.

En cas de session expirée, d’erreur réseau, de refus HTTP ou de changement
d’interface : le bot enregistre une pause persistante. Arrête le service, corrige
la connexion dans `collection-login`, puis arrête ce mode avec Ctrl+C :

```bash
sudo docker compose run --rm -e COLLECTION_APPLY=true wiki-bot collection-resume
sudo docker compose -f compose.yaml -f compose.collection.yaml up -d wiki-collection
```

Une simple relance ne lève pas la pause. `collection-resume` ne démarre aucun
parcours et ne change pas les seuils. Le service doit être arrêté pour cette commande.
Avec `--fresh`, elle efface uniquement la progression, la position et la pause du
mode sélectionné dans `.env`, pour préparer un nouveau passage depuis la page 1.

Après un arrêt brutal uniquement, si `collection_locked` persiste alors que tous
les processus de ce bot sont arrêtés :

```bash
sudo docker compose run --rm wiki-bot collection-unlock --stopped
```

Sur Docker Linux, le bot possède désormais un verrou système `flock`, libéré
automatiquement quand le conteneur s’arrête, même brutalement. Une ancienne
métadonnée de ce nouveau verrou est récupérée seulement après acquisition du
verrou système. Un ancien verrou de la version précédente reste protégé jusqu’au
déverrouillage explicite. Le fichier `collection.guard` reste présent : sa
présence ne signifie pas que le bot est actif et il ne faut pas le supprimer.

Pour migrer une installation restée en boucle `collection_locked`, exécute dans
le dossier existant, en laissant chaque commande se terminer :

```bash
sudo docker compose -f compose.yaml -f compose.collection.yaml stop wiki-bot wiki-collection
git pull --ff-only origin main
sudo docker compose -f compose.yaml -f compose.collection.yaml build wiki-collection
sudo docker compose -f compose.yaml -f compose.collection.yaml run --rm --no-deps wiki-collection collection-unlock --stopped
sudo docker compose -f compose.yaml -f compose.collection.yaml run --rm --no-deps wiki-collection collection-resume
sudo docker compose -f compose.yaml -f compose.collection.yaml up -d --force-recreate wiki-collection
sudo docker compose -f compose.yaml -f compose.collection.yaml logs --tail=100 wiki-collection
```

Arrête aussi tout ancien conteneur de test ou de connexion qui utiliserait ce
même volume. Le déverrouillage affiche le chemin exact et indique si un fichier
a été retiré ou s’il était déjà absent. `collection-status` affiche le propriétaire
enregistré du verrou (commande, conteneur, date), sans cookie ou jeton.
Un service qui rencontre un verrou occupé reste en attente, consultable, sans
redémarrer son bureau en boucle. Arrête-le avant les commandes de maintenance.
La connexion et la progression restent conservées ; `--fresh` n’est pas nécessaire
pour réparer uniquement le démarrage.

L’interface n’expose pas d’identifiant unique d’exemplaire dans les cartes du
tableau. La reprise s’appuie donc sur l’ordre, les titres, les raretés et les
statistiques ATK/DEF de chaque page, pas seulement sur le nom. Les pages déjà
traitées sont revérifiées en avançant. Si une page a changé (`collection_changed`),
ou si tu modifies les seuils (`scan_policy_changed`), recommence explicitement :

```bash
sudo docker compose -f compose.yaml -f compose.collection.yaml stop wiki-collection
sudo docker compose -f compose.yaml -f compose.collection.yaml run --rm --no-deps wiki-collection collection-resume --fresh
sudo docker compose -f compose.yaml -f compose.collection.yaml up -d --force-recreate wiki-collection
sudo docker compose -f compose.yaml -f compose.collection.yaml logs -f --tail=50 wiki-collection
```

`--fresh` remet les compteurs du parcours à zéro. Les étiquettes et la connexion
restent présentes. Le bot ne peut pas distinguer deux exemplaires strictement
identiques qui auraient été intervertis : conserve la collection stable pendant un passage.

Ne lance qu’un seul navigateur sur ce profil : arrête les bots de marché,
d’ouverture et les modes manuels avant le bot collection. Un profil occupé
produit une erreur d’initialisation et une pause.

## Test local sur Windows

Depuis le dossier du projet :

```powershell
npm ci
npx playwright install chromium
npm run collection:login
# Connecte-toi dans Chromium puis Ctrl+C.
npm run collection:scan -- --dry-run --limit 10
npm run collection:scan -- --apply --limit 10
# Continuer le parcours réel :
npm run collection:scan -- --apply
# Lire le rapport réel sans changer .env :
node --env-file=.env src/index.mjs collection-report
```

Pour la dernière commande, `.env` doit contenir `COLLECTION_APPLY=true`.
Les commandes npm ne lisent pas automatiquement `.env` ; elles prennent les
variables du terminal. Les valeurs par défaut suffisent pour les essais.
La session locale est enregistrée dans `data/chromium`, séparée d’Edge et du VPS.

Pour utiliser Edge installé sur Windows plutôt que télécharger Chromium :

```powershell
$env:COLLECTION_BROWSER_CHANNEL = 'msedge'
npm run collection:login
```

Conserve cette variable dans le même terminal pour les essais suivants. Il s’agit
d’un profil Edge distinct, stocké dans le dossier du bot. Sur le VPS Docker,
laisse cette variable vide pour utiliser Chromium fourni par l’image.

## Validation

```bash
npm test
npm run test:collection:browser
```

La CI vérifie aussi le cycle Docker réel sur un volume temporaire : deux
parcours concurrents, refus de déverrouiller un parcours actif, `SIGKILL` suivi
d’une reprise, arrêt propre, commandes `resume` répétées et migration de l’ancien
verrou. Ce test n’utilise aucun compte et ne contacte pas WikiMasters.

Le test navigateur exécute aussi la commande complète : fin après `--limit 1`,
code de sortie 0, fermeture du navigateur, suppression du verrou et reprise à
la carte suivante. Il vérifie la fermeture après erreur, ainsi que la veille
du service après un parcours terminé sous Linux. Une fermeture volontaire ne
retire que le gestionnaire du bot et conserve les gestionnaires internes de Playwright.

Le deuxième test utilise un **site fictif sur 127.0.0.1**, avec Chromium, deux
copies identiques, plusieurs pages, les filtres exclusifs « Toutes / Rare / Peu commun /
Super Rare » et une variante à sélection multiple, des seuils à la limite,
Sergio Gómez à 12 WB / 25 ventes, une absence de vente, un en-tête de rareté
contradictoire et un refus HTTP 429. Il vérifie un enregistrement via `/collection`,
via `/api/mock-label` et sur un deuxième serveur local, la relecture d’une SR sur une page ultérieure, la
commande complète en étiquetage et le refus d’un badge optimiste non enregistré.
Aucun accès au compte n’est nécessaire.

Vérifications sur le vrai site le 14 novembre 2026 : connexion Edge déjà active,
lecture du marché Rare de « Versatile (sexualité) » (moyenne 232 WB, 200 ventes),
ajout puis affichage confirmé de « à vendre », et carte Commune « Trans7 » sans
vente, laissée intacte. Le 15 novembre, une consultation locale en lecture seule
de Broad Peak [SR] a confirmé que son étiquette était bien enregistrée malgré
l’ancienne pause de confirmation. Les nouvelles écritures sont validées sur le
site fictif local ; aucun test d’écriture supplémentaire n’a été effectué sur le compte réel.

Références techniques : [sélecteurs Playwright](https://playwright.dev/docs/api/class-locator)
et [services/profils Docker Compose](https://docs.docker.com/reference/compose-file/services/#profiles).
