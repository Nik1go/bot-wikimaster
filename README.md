# WikiMasters — marché en simulation, paquets en veille

La première version du marché est disponible : sélection d’une légendaire à la
fois, plafond 3 500 WB et 50 % de la référence, contrôle du portefeuille,
classement par plus grand écart en WB, suivi des contre-enchères et logs explicatifs.
Elle est livrée en simulation ; aucun achat ne démarre par défaut.
Voir [les règles, commandes et limites du marché](MARKET.md) et lancer
`docker compose run --rm wiki-bot market-demo` pour une démo sans accès au site.

Prototype pour un VPS Ubuntu avec Docker Compose. Il utilise un Chromium avec
un profil conservé dans un volume Docker. Connexion manuelle dans le navigateur
du VPS. Les ouvertures automatiques sont désormais désactivées par défaut avec
`PACK_OPENING_ENABLED=false`, y compris si un ancien `.env` ne contient pas encore
cette variable.

En veille, `run` garde le service actif sans lancer Chromium, noVNC ou une requête
vers le jeu ; `once` se termine sans ouverture. Le journal indique
`pack_opening_disabled`. La commande `resume` ne réactive pas les paquets.
`status` affiche `packOpeningEnabled: false`. Les modes manuels et le contrôle
en lecture seule `check` restent disponibles sur demande. Les commandes du marché
sont distinctes et documentées dans [MARKET.md](MARKET.md).

Si les ouvertures sont explicitement réactivées, les sessions sont espacées d'au
moins 60 minutes. À chaque session, il ouvre les paquets gratuits disponibles au départ, au maximum
10. Par défaut : 15 secondes entre les paquets et 2 secondes entre les cartes.
Le quota ne s'étend pas aux paquets régénérés pendant la session. Le module des
paquets ne touche pas à la boutique, au marché, aux échanges, aux favoris ou aux paquets payants.

Les pauses servent à espacer les actions. Elles ne garantissent ni une apparence
humaine ni une absence de détection. Les règles de WikiMasters interdisent
l'automatisation et prévoient des sanctions :
https://www.wiki-masters.com/rules et https://www.wiki-masters.com/terms.

## Installation

Sur le VPS :

```bash
git clone https://github.com/Nik1go/bot-wikimaster.git
cd bot-wikimaster
cp .env.example .env
docker compose build
docker compose run --rm wiki-bot smoke
```

Il faut le greffon `docker compose` (Compose v2), un VPS Linux x86_64 ou ARM64
compatible avec l'image Playwright, et assez de mémoire pour Chromium. Prévoir
en pratique environ 2 Go de RAM libres et plusieurs Go de disque pour l'image.

### 1. Connexion initiale

```bash
docker compose run --rm --service-ports wiki-bot login
```

Laisse cette commande active. Depuis **ton ordinateur**, dans un autre terminal,
ouvre un tunnel SSH en remplaçant l'utilisateur et l'adresse :

```bash
ssh -N -L 6080:127.0.0.1:6080 utilisateur@adresse-du-vps
```

Ouvre ensuite dans ton navigateur :

```text
http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale
```

Connecte-toi normalement à WikiMasters dans le Chromium du VPS. C'est un profil
distinct du navigateur de Codex : la connexion faite ici n'est pas copiée.
Si un contrôle demande une action, effectue-la toi-même dans ce navigateur.
Reviens sur la page « Paquets », puis arrête le premier terminal avec Ctrl+C.
Ce mode n'ouvre aucun paquet.

Le bureau distant est publié uniquement sur `127.0.0.1` du VPS et passe par le
tunnel SSH. Le volume Docker contient la session authentifiée : conserve-le privé.

### 2. Vérification sans ouverture

```bash
docker compose run --rm wiki-bot check
```

Une ligne `check_ok` doit indiquer le nombre de paquets disponibles. En cas de
pause, règle le problème dans le mode `login`, puis lève la pause :

```bash
docker compose run --rm wiki-bot resume
```

### 3. Service en veille

Conserve `PACK_OPENING_ENABLED=false` dans `.env`. Pour vérifier la veille :

```bash
docker compose run --rm wiki-bot once
docker compose run --rm wiki-bot status
```

Pour lancer le service :

```bash
docker compose up -d
docker compose logs -f --tail=50 wiki-bot
```

En veille, aucune session de paquets ne démarre. Si les ouvertures sont
explicitement réactivées, le premier lancement est immédiat, sauf si une session a déjà démarré il y a
moins d'une heure. Ensuite, les départs sont espacés d'au moins 60 minutes.
Les redémarrages conservent cette limite. Les heures de log sont en UTC.

Ne lance pas deux commandes de navigateur en même temps : le profil est partagé.
Arrête le service avant d'utiliser `login`, `check` ou `once` :

```bash
docker compose stop
```

## Mise à jour depuis GitHub

Pour une instance qui tourne encore avec l'ancienne version, commence par
`sudo docker compose stop wiki-bot` sur le VPS. Mettre à jour les fichiers locaux
ne stoppe pas le conteneur distant. Une fois cette version transférée et
`PACK_OPENING_ENABLED=false` conservé dans `.env`, reconstruis le service :

```bash
sudo docker compose up -d --build --force-recreate wiki-bot
sudo docker compose logs --tail=20 wiki-bot
```

La ligne attendue est `pack_opening_disabled` ; aucun navigateur n'est lancé
par le service en veille.

Dans le dossier du projet sur le VPS :

```bash
docker compose stop
git fetch origin
git pull --ff-only origin main
docker compose up -d --build
docker compose logs -f --tail=50 wiki-bot
```

Le volume de connexion et le fichier `.env` sont conservés. `git fetch` récupère
les références distantes ; `git pull --ff-only` met à jour les fichiers locaux
sans créer de commit de fusion. Si Git signale des modifications locales,
arrête-toi pour les examiner plutôt que de les écraser.

## Vérifications humaines et incidents

### Diagnostic d'un échec Cloudflare à la connexion

Le mode `login` habituel reste un navigateur lancé par Playwright, même si tu y
saisis toi-même tes identifiants. Pour comparer avec un navigateur sans pilotage
automatique sur le même VPS, arrête ce mode avec Ctrl+C, puis :

```bash
docker compose stop
git pull --ff-only origin main
docker compose build
docker compose run --rm --service-ports wiki-bot manual
```

Rouvre le même bureau noVNC via ton tunnel SSH et teste manuellement la connexion.
Le mode `manual` lance directement le Chromium installé, sans connexion d'un
pilote Playwright ni modification d'identité du navigateur. Il conserve le bac
à sable et utilise un profil distinct. Aucun paquet ne s'ouvre automatiquement,
et son profil reste séparé tant que tu ne le sélectionnes pas explicitement pour le bot.

Si la vérification passe ici mais échoue dans `login`, cela oriente le diagnostic
vers l'environnement automatisé. Si elle échoue aussi ici, il faut encore
examiner le réseau, la compatibilité du navigateur et le code d'erreur : cela ne
prouve pas un blocage général de l'hébergeur.

Le code `600010` appartient à la famille d'échecs associée par Cloudflare à des
signaux d'automatisation. Cloudflare ne prend pas en charge les navigateurs
automatisés pour résoudre ses challenges en production. Une cadence plus lente
entre les ouvertures ne résout pas un échec à la connexion.

Sources :
https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/
et https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/.

### Tester le bot avec une connexion faite dans le mode manuel

Si tu t'es connecté dans le mode `manual`, tu peux sélectionner ce profil
persistant pour le bot. Cette sélection n'exporte aucune donnée de connexion et
ne modifie pas `.env`. Le profil reste dans le volume Docker privé. La sélection
ne garantit pas que Cloudflare acceptera ensuite le navigateur automatisé.

Sur le VPS, dans le dossier du projet (les commandes ci-dessous utilisent sudo) :

```bash
sudo git pull --ff-only origin main
sudo docker compose build
sudo docker stop wiki-manual
sudo docker compose stop
sudo docker compose run --rm wiki-bot use-manual-session
sudo docker compose run --rm wiki-bot check
```

`wiki-manual` est le nom du conteneur manuel lancé avec `--name wiki-manual`.
Le bureau noVNC se déconnecte quand ce conteneur est arrêté : c'est attendu.
N'exécute pas le mode manuel et le bot en même temps sur ce profil.

Si `check_ok` apparaît, conserve les paquets en veille et vérifie la configuration :

```bash
sudo docker compose run --rm wiki-bot status
sudo docker compose run --rm wiki-bot once
```

`status` doit afficher `packOpeningEnabled: false` et `once` doit écrire
`pack_opening_disabled`. Aucun paquet ne s'ouvre. `resume` lève seulement une
pause après incident, sans réactiver les ouvertures ni annuler le délai horaire.

Pour garder le service en veille :

```bash
sudo docker compose up -d
sudo docker compose logs -f --tail=50 wiki-bot
```

Le profil sélectionné est conservé, mais le service en veille ne l'ouvre pas.
Ctrl+C quitte les logs sans arrêter le service. Le tunnel SSH et noVNC restent
utiles pour les modes manuels, lancés explicitement.

Le code du site peut demander une « Vérification rapide ». Le bot attend jusqu'à
120 secondes que le site se valide normalement. Il ne clique pas dans Turnstile,
ne résout pas de puzzle, et ne fabrique aucun jeton de vérification.

Si la vérification reste bloquée, si la session expire, si le serveur refuse une
ouverture ou si son résultat est incertain, le bot se met en pause persistante.
Il n'essaie pas de rattraper les clics ni de relancer l'ouverture ambiguë.
Une ligne `paused`, un fichier `state/paused.json` et une capture `state/pause.png`
sont enregistrés dans le volume. Les alertes sont locales (logs), sans envoi
Discord, e-mail ou SMS.

Pour lire l'état d'un service actif :

```bash
docker compose exec wiki-bot node src/index.mjs status
```

Pour intervenir :

```bash
docker compose stop
docker compose run --rm --service-ports wiki-bot login
# Après avoir réglé le problème et arrêté login avec Ctrl+C :
docker compose run --rm wiki-bot check
docker compose run --rm wiki-bot resume
docker compose up -d
```

La levée de pause conserve le délai horaire. Un redémarrage seul ne lève pas une pause.

## Réglages

Modifie `.env`, puis applique avec `docker compose up -d --force-recreate`.

| Variable | Défaut | Effet |
| --- | --- | --- |
| `PACK_OPENING_ENABLED` | `false` | Veille des paquets ; seul `true` réactive explicitement les ouvertures |
| `INTERVAL_MINUTES` | `60` | Minutes entre les départs, minimum 60 |
| `MAX_PACKS_PER_SESSION` | `10` | Maximum d'ouvertures par session, de 1 à 10 |
| `BETWEEN_PACKS_SECONDS` | `15` | Pause entre les paquets, de 3 à 300 s |
| `BETWEEN_CARDS_SECONDS` | `2` | Pause entre les révélations, de 1 à 30 s |
| `VERIFICATION_TIMEOUT_SECONDS` | `120` | Attente maximale de l'ouverture, de 15 à 180 s |

Les captures `last.png` et `pause.png` sont remplacées à chaque nouvel événement.
Les journaux applicatifs se trouvent dans `state/events.jsonl` du volume.

## Limites et validation

Les sélecteurs proviennent de l'interface observée le 24 octobre 2026. Les
boutons suivants utilisent actuellement une flèche SVG sans nom accessible ;
si le site change son interface, le bot peut se mettre en pause.

Un paquet a été ouvert manuellement avec l'autorisation du propriétaire pour
vérifier le parcours de révélation des cinq cartes. Cette ouverture confirme
le parcours observé, pas le fonctionnement du conteneur.

Tests locaux : `npm test` (Node.js 22 ou ultérieur). Les scénarios du contrôleur,
de la persistance et de l'adaptateur sont simulés ; ils ne contactent pas le jeu.
L'image Docker et la réaction de Turnstile depuis l'IP du VPS restent à vérifier
sur le VPS. Le moteur Docker local n'était pas actif pendant la préparation.
Le workflow GitHub vérifie aussi la construction de l'image et le lancement de
Chromium sur une page vide. Il n'ouvre pas de session WikiMasters ni de paquet.

Le navigateur tourne sous `pwuser`, avec le bac à sable Chromium activé et le
profil seccomp officiel de Playwright. En cas d'erreur de bac à sable, inspecte
la configuration du noyau/AppArmor et les logs ; ne retire pas le bac à sable
automatiquement.

Sources techniques :

- https://playwright.dev/docs/docker
- https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
- https://github.com/microsoft/playwright/blob/v1.64.0/utils/docker/seccomp_profile.json

Le profil seccomp est repris du projet Playwright (Microsoft, licence Apache
2.0 fournie dans `docker/PLAYWRIGHT-LICENSE.txt`). La version du package et de
l'image est fixée à 1.64.0.
