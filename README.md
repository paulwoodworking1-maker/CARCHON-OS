# Carchon OS

Le logiciel de fabrication et de logistique de Carchon Les Ateliers, pendant de Cockpit (vente et finance).

**Version complète** (présentation alignée sur Cockpit) :
- **Fabriquer** : ordres de fabrication (sur-mesure, boutique, revendeurs, salons), catalogue des modèles avec nomenclature et carnet type, lancement d'un lot en un clic (pièces numérotées, bois réservé, achats manquants proposés), carnets de fabrication, portails clients.
- **Planifier** : charge sur 12 semaines par personne (absences déduites), planning automatique, livraisons et poses.
- **Approvisionner** : bois noble par lot, pièces finies comptées avec seuil boutique, consommables en trois états, achats et fournisseurs.
- **Livrer et garantir** : contrôle qualité, registre des pièces (numéro, bois, fiches, contrôle, expédition, SAV), expéditions avec bon de livraison, demandes SAV.
- **Piloter** : heures et chiffrage, coût réel par OF, machines (entretiens à la date ou à l'usage calculé depuis les fiches, pannes, pièces d'usure), automatisations, équipe.
- **Liaison Cockpit** : API `POST /api/v1/affaires`, `POST /api/v1/affaires/{réf}/acompte`, `GET /api/v1/ofs` (clé dans Équipe et réglages › Entreprise).

Le logiciel de l'atelier, construit d'après les maquettes « Carchon OS · version retenue ».

- **Patron (ordinateur)** : Aujourd'hui (à décider, projets, atelier du jour, signalements), Projets (frise automatique, fiche projet, plans, journal photo, documents), Carnets de fabrication, Portails clients, Planning par personne, Livraisons et poses (avec PV signé au doigt), Stock en 3 états, Achats (à commander, commandes en cours, fournisseurs), Pilotage (heures réelles vs chiffrées par geste, export CSV), Réglages équipe.
- **Atelier (iPad)** : chacun choisit son prénom et tape son code à 4 chiffres. Ma prochaine tâche, Mon carnet, l'étape en cours (repères, photo, signaler, « Ça t'a pris combien ? »), Il manque, Stock.
- **Client (téléphone)** : lien privé pour accepter un devis (vérification de l'e-mail par code à 6 chiffres, signature électronique simple, preuve conservée) puis espace de suivi (avancement, date « prête à poser vers le », photos partagées, documents, PV).

Ce qui est encore **manuel** dans cette première version : le PDF du devis est déposé à la main (export Qonto), l'acompte se note dans la fiche projet, les commandes fournisseurs partent par un e-mail pré-rempli.

## Fiche projet et dossier de production

La fiche d’un projet est rangée en quatre onglets, sous la frise et un bandeau « À suivre » (carnet, sous-traitance, achats, livraison) :
- **Vue d’ensemble** : prochaine action, infos du projet, acompte, temps passé, historique.
- **Dossier de production** : le carnet de fabrication, sa génération depuis les plans, la liste de débit, les dictées, les plans, les éléments, le contrôle. « Imprimer le dossier » sort tout sur papier.
- **Achats et sous-traitance** : les commandes aux sous-traitants (à commander → commandé → chez le sous-traitant → revenu → contrôlé), avec bon de commande imprimable, e-mail pré-rempli et devis joint ; les achats liés et le bois réservé. Un retour en retard remonte dans « À décider ».
- **Client et documents** : journal photo, portail client, documents.

**Générer le carnet** : coche les plans (PDF ou image JPG/PNG) et dicte le travail (bouton « Dicter » sur iPad/Chrome, ou la dictée du clavier). L’assistant (`AI_MODEL`, par défaut `claude-opus-5-5`) lit cotes, assemblages et matières et propose les fiches, la liste de débit et les éléments. La sous-traitance reste ta décision : il tient compte de celles que tu as saisies, sans en proposer. Rien ne part à l’atelier avant « Envoyer à l’atelier ». Nécessite `ANTHROPIC_API_KEY`.

## Démarrer

Il faut Node.js 22.13 ou plus récent (la base SQLite est intégrée, rien d'autre à installer).

```bash
npm install
```

```bash
npm start
```

Ouvrir http://localhost:3000 : au premier lancement, on choisit le mot de passe du patron. Ensuite : Pilotage › Réglages équipe pour créer les codes iPad, Portails clients pour déposer les CGV et les adresses de test.

### Essayer avec les données des maquettes

```bash
DATA_DIR=./data-demo npm run demo
```

```bash
DATA_DIR=./data-demo npm start
```

Patron : `demo-atelier` · iPad : Lucas `1111`, Nina `2222`, patron `0000` · adresse de test du portail : `test@example.com`.

## Mettre en ligne

**En un clic sur Render** (environ 7 $ par mois + disque) : [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/paulwoodworking1-maker/CARCHON-OS). Tout est réglé dans `render.yaml` ; à la fin, ouvre l'adresse donnée par Render et choisis ton mot de passe patron.

Une seule application et un dossier de données (`DATA_DIR`) à garder sur un disque persistant et **à sauvegarder** (il contient la base `carchon.db` et toutes les photos, plans, devis et PV).

- Avec Docker : `docker build -t carchon-os .` puis `docker run -p 3000:3000 -v carchon-data:/data --env-file .env carchon-os`
- Sur un hébergeur (Render, Railway, Fly.io, un VPS…) : commande de démarrage `npm start`, un disque persistant monté sur `DATA_DIR`, HTTPS activé, et les variables de `.env.example` (au minimum `PUBLIC_URL` et `COOKIE_SECURE=1`).

Pour que les clients reçoivent leur code par e-mail, renseigner `SMTP_*` (l'adresse d'envoi de ta messagerie). Sans SMTP, en **mode test**, le code s'affiche sur la page du client ; en mode réel, il est seulement écrit dans le journal du serveur.

## Portail client : bon à savoir

- Le portail démarre en **mode test** : seules les adresses de test reçoivent un lien et les pages portent la mention « sans valeur contractuelle ». Le passage en réel se fait dans Portails clients, après l'avis de ton juriste.
- Les liens ne sont montrés qu'une fois (seule leur empreinte est gardée). Un lien perdu se recrée.
- Le client ne voit jamais de prix de revient, de fournisseur ni de note interne : seulement l'avancement, les photos cochées « Partagée au client » et les documents cochés « Client ».

## E-mails et SMS aux clients

- **Codes de validation des devis** : soit `BREVO_API_KEY` + `MAIL_FROM` (adresse validée comme expéditeur dans Brevo), soit `GMAIL_USER` + `GMAIL_APP_PASSWORD` (mot de passe d'application Google).
- **SMS de suivi** : `BREVO_API_KEY` (compte Brevo avec un pack de SMS). Un SMS court part au client à chaque nouveauté de son portail, regroupé sur 15 minutes, jamais la nuit ni le dimanche. Modèles modifiables dans Portails clients › Réglages et e-mails.
- **Brouillons Gmail** : « Créer le brouillon Gmail » ouvre un message rédigé dans Gmail (rangé dans Brouillons).

## Sauvegardes

Chaque nuit, une copie complète de la base est écrite dans `DATA_DIR/sauvegardes/` (les 14 dernières sont gardées). Dans Réglages › Entreprise › Sauvegardes, on peut en télécharger une à tout moment : en ranger une chaque semaine hors du serveur.

## Tests

```bash
npm test
```
