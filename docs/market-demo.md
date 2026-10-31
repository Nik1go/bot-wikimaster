# Journal du marché

Les montants simulés ne sont pas des achats. Les écarts à la moyenne ne sont pas des bénéfices garantis.

| Heure | Événement | Carte / enchère | Montant WB | Explication |
| --- | --- | --- | ---: | --- |
| 31/10/2026 13:00:00 | simulation / scan_started |  |  | Repérage horaire : légendaires avec image, fin entre 30 et 120 secondes par défaut. |
| 31/10/2026 13:00:00 | simulation / wallet_checked |  |  | Solde disponible : 5000 WB ; réserve : 0 WB. |
| 31/10/2026 13:00:00 | simulation / candidate_eligible | Carte Démo A | 300 | Admissible : prochaine mise 300 WB, moyenne 1000 WB sur 3 ventes ; écart 700 WB. |
| 31/10/2026 13:00:00 | simulation / candidate_eligible | Carte Démo B | 2800 | Admissible : prochaine mise 2800 WB, moyenne 7000 WB sur 3 ventes ; écart 4200 WB. |
| 31/10/2026 13:00:00 | simulation / scan_finished |  |  | 3 annonces vues, 2 occasions évaluées admissibles. |
| | Motifs de rejet | | | missing_image: 1 |
| 31/10/2026 13:00:00 | simulation / candidate_selected | Carte Démo B | 2800 | Choix : Carte Démo B. Écart estimé 4200 WB ; plafond figé 3500 WB. |
| 31/10/2026 13:00:00 | simulation / would_bid | Carte Démo B | 2800 | SIMULATION : mise proposée 2800 WB. Aucun achat envoyé. |
| 31/10/2026 13:00:15 | simulation / end_changed | 00000000-0000-4000-8000-000000000002 |  | Date de fin mise à jour par le serveur ; suivi adapté à la prolongation. |
| 31/10/2026 13:00:15 | simulation / simulated_outbid | Carte Démo B |  | Une mise concurrente nécessite de recalculer la prochaine mise autorisée. |
| 31/10/2026 13:00:15 | simulation / would_bid | Carte Démo B | 3191 | SIMULATION : contre-mise proposée 3191 WB. Aucun achat envoyé. |
| 31/10/2026 13:00:30 | simulation / simulated_outbid | Carte Démo B |  | Une mise concurrente nécessite de recalculer la prochaine mise autorisée. |
| 31/10/2026 13:00:30 | simulation / ceiling_reached | Carte Démo B | 3521 | Abandon : prochaine mise 3521 WB supérieure au plafond 3500 WB. |
| 31/10/2026 13:02:35 | simulation / simulation_finished | Carte Démo B |  | Suivi simulé terminé. Le gagnant réel ne permet pas de déduire le gagnant d’une enchère hypothétique. |
