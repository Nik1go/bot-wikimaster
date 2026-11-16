# Remettre « à vendre » sur les invendues

Le service lit l’onglet **Marché → Historique**, enregistre une liste complète,
puis retrouve dans la collection les cartes **Non vendues** portant **Possédée**.
Il remet uniquement l’étiquette `à vendre` manquante, sans mettre de carte aux
enchères. Il couvre toutes les raretés, indépendamment des seuils du bot de tri.

L’interface observée le 16 novembre 2026 affiche les **50 dernières ventes**,
sans bouton pour remonter plus loin. Le bot traite tout cet historique visible ;
il suit aussi « Charger la suite » si le site le propose. Il ne peut pas retrouver
une vente que le site ne montre plus. Un passage quotidien réduit ce risque,
mais plus de 50 ventes entre deux passages peuvent entraîner des omissions.

Les répétitions d’une carte dans l’historique sont regroupées par titre, rareté,
ATK et DEF. La carte est recherchée avec ces quatre critères dans la collection.
Si elle a disparu ou si plusieurs exemplaires strictement identiques empêchent
de savoir lequel était en vente, le bot la laisse intacte et l’indique au rapport.
Une étiquette déjà présente compte comme `already_tagged` : elle n’est jamais
retirée ni ajoutée une seconde fois.

## Premier passage sur le VPS

Utiliser le même dossier Compose, le même volume et la connexion existante du
bot. Une connexion dans Edge sur le PC ne connecte pas le navigateur du VPS.
Les commandes ci-dessous supposent que les nouveaux fichiers ont été transférés
dans le projet du VPS. Ne pas modifier `PACK_OPENING_ENABLED=false`.

Arrêter les autres commandes utilisant le navigateur partagé : tri, marché,
paquets, connexion ou mode manuel. Le verrou de collection protège les parcours
de tri et de restauration. Les anciens modes marché, paquets et manuel ont leurs
propres verrous : ne pas les exécuter simultanément sur ce profil.

```bash
sudo docker compose stop wiki-bot
sudo docker compose -f compose.yaml -f compose.collection.yaml --profile collection stop wiki-collection
sudo docker compose -f compose.yaml -f compose.relabel.yaml --profile relabel build wiki-relabel

# Simulation : recherche réelle, aucune modification des cartes.
sudo docker compose -f compose.yaml -f compose.relabel.yaml --profile relabel run --rm wiki-relabel relabel-once --dry-run
sudo docker compose -f compose.yaml -f compose.relabel.yaml --profile relabel run --rm wiki-relabel relabel-report --dry-run

# Ajouter les étiquettes manquantes immédiatement.
sudo docker compose -f compose.yaml -f compose.relabel.yaml --profile relabel run --rm wiki-relabel relabel-once --apply
```

Si la connexion a expiré, arrêter le service et utiliser le mode habituel
`collection-login` avec noVNC (voir [COLLECTION.md](COLLECTION.md)), puis
`relabel-resume --apply`. La session reste dans le volume privé.

## Service quotidien

Ajouter dans `.env` :

```dotenv
RELABEL_APPLY=true
RELABEL_DELAY_SECONDS=3
RELABEL_TIMEOUT_SECONDS=30
```

Puis lancer uniquement ce service :

```bash
sudo docker compose -f compose.yaml -f compose.relabel.yaml --profile relabel up -d --build wiki-relabel
sudo docker compose -f compose.yaml -f compose.relabel.yaml --profile relabel logs -f --tail=50 wiki-relabel
```

Premier passage immédiatement si aucun passage réel n’a eu lieu depuis 24 h ;
ensuite au moins **24 h entre deux départs**, avec navigateur fermé entre les
passages. L’heure du départ est sauvegardée avant l’ouverture du navigateur :
un redémarrage du conteneur ne relance pas un passage trop tôt. Un passage manqué
est effectué au redémarrage ; aucun rattrapage multiple. Les logs sont en UTC.

`relabel-once --apply` est une commande manuelle immédiate : elle peut être
répétée pour vérifier les étiquettes et remet le délai automatique à 24 h après
son départ. Les simulations possèdent leur propre planning et leur propre état.
`RELABEL_APPLY=false` laisse le service en simulation, sans ajouter d’étiquette.

Le navigateur est verrouillé uniquement pendant le passage. Si le tri utilise
le profil, la restauration attend et contrôle le verrou une minute plus tard.
Le service `collection-run` conserve son verrou même en veille après son
parcours : l’arrêter pour permettre les passages quotidiens de restauration.

## Rapport, erreurs et reprise

Sur un service actif :

```bash
sudo docker compose -f compose.yaml -f compose.relabel.yaml --profile relabel exec wiki-relabel node src/index.mjs relabel-status
sudo docker compose -f compose.yaml -f compose.relabel.yaml --profile relabel exec wiki-relabel node src/index.mjs relabel-report
```

Les fichiers sont dans `/data/relabel/apply/state/` (ou `simulation/state/`) :

- `plan.json` : liste dédupliquée, ventes d’origine, résultat par carte et compteurs ;
- `last-run.json` : dernier passage terminé ;
- `schedule.json` : départ sauvegardé du dernier passage ;
- `events.jsonl` : journal ; `current.json` : opération en cours ;
- `paused.json` et `pause.png` : incident nécessitant une intervention.

Une erreur locale de carte est enregistrée, sans refaire le clic incertain,
puis le bot poursuit la liste. Les étiquettes ajoutées sont relues après un
rechargement complet. Un refus HTTP, une limitation, une demande de vérification,
une session expirée ou une panne globale ferme le navigateur et met le service
en pause persistante. Il ne redémarre pas les requêtes en boucle.

Après correction de la cause, arrêter le service puis lever sa pause :

```bash
sudo docker compose -f compose.yaml -f compose.relabel.yaml --profile relabel stop wiki-relabel
sudo docker compose -f compose.yaml -f compose.relabel.yaml --profile relabel run --rm wiki-relabel relabel-resume --apply
# Facultatif : réessayer tout de suite, avec nouvelle lecture des étiquettes.
sudo docker compose -f compose.yaml -f compose.relabel.yaml --profile relabel run --rm wiki-relabel relabel-once --apply
sudo docker compose -f compose.yaml -f compose.relabel.yaml --profile relabel up -d wiki-relabel
```

Sur Linux, le verrou système est libéré même en cas d’arrêt brutal et les
anciennes métadonnées sont récupérées au prochain passage. Si un ancien verrou
créé sans verrou système bloque la reprise, arrêter **tous** les parcours puis
utiliser `collection-unlock --stopped` avec le service de collection existant.
Ne jamais effacer `collection.guard`. Sous Windows, un arrêt brutal peut
nécessiter ce même déverrouillage explicite.

## Vérification locale sans compte

```bash
npm test
npm run test:relabel:browser
```

Les tests de navigateur utilisent un faux site local : historique paginé,
étiquetage relu après rechargement, simulation, doublons, carte déjà étiquetée,
refus serveur et écriture non persistée. Ils ne contactent pas WikiMasters.

Comme les autres modules, celui-ci utilise l’interface normale du site et
respecte les demandes de vérification ; voir les limites d’automatisation dans
le [README](README.md).
