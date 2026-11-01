# Comparaison hors ligne : décote de 20 % / 30 %

**DONNÉES FICTIVES — vérification du fonctionnement uniquement.**

Observation : 2026-11-01T12:00:00Z. Une position par scénario ; plafond 3500 WB ; solde 5000 WB ; réserve 0 WB.

Référence : quartile inférieur empirique (rang ⌈n/4⌉), au moins 5 et au plus 10 ventes récentes sur 30 jours, filtrées à la date de l’observation.

| Décote minimale | Admissibles | Carte retenue | Mise proposée WB | Référence WB | Écart brut WB | Plafond WB |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| 20 % | 2 | Démo A : décote discrète | 3100 | 4000 | 900 | 3200 |
| 30 % | 1 | Démo B : décote plus forte | 1600 | 2400 | 800 | 1680 |

| Carte | Ventes retenues / variante inconnue | Référence WB | Résultat à 20 % | Résultat à 30 % |
| --- | ---: | ---: | --- | --- |
| Démo A : décote discrète | 5 / 0 | 4000 | RETENUE — Retenue : première au classement par écart en WB, puis décote et échéance. | REJET : above reference limit — La prochaine mise dépasse le plafond conservant 30 % de décote. |
| Démo B : décote plus forte | 5 / 0 | 2400 | ADMISSIBLE — Admissible ; une autre carte est classée avant elle. | RETENUE — Retenue : première au classement par écart en WB, puis décote et échéance. |
| Démo C : moyenne gonflée | 5 / 0 | 2000 | REJET : above reference limit — La prochaine mise dépasse le plafond conservant 20 % de décote. | REJET : above reference limit — La prochaine mise dépasse le plafond conservant 30 % de décote. |
| Démo D : budget dépassé | — | — | REJET : per card limit — La prochaine mise dépasse 3 500 WB ou le plafond configuré. | REJET : per card limit — La prochaine mise dépasse 3 500 WB ou le plafond configuré. |

Les scénarios sont indépendants : leurs mises ne sont ni envoyées ni cumulées. Le classement reste le plus grand écart en WB.

Les écarts sont avant frais. La référence porte sur la même carte et la rareté L ; elle ne garantit pas des statistiques ou variantes identiques. Les variantes non renseignées sont signalées.

La concurrence et le délai de revente ne sont pas modélisés. Aucun gagnant, vente ou bénéfice réalisé n’est déduit de cette comparaison.
