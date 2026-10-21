# Traversal (local / LAN / traversalgame.com)

Client 3D du jeu [Traversal](https://www.traversalgame.com/rules), fait avec three.js (plateau 3D),
pixi.js (interface) et @ghom/booyah (state machines). On peut y jouer à deux en local ou en réseau,
ou jouer des parties du site officiel depuis ce client. Projet perso, non officiel.

## Origine

Le jeu n'est pas de moi : il vient de [traversalgame.com](https://www.traversalgame.com) et de
[darkfireXXI/board_game](https://github.com/darkfireXXI/board_game). Ce repository est juste un portage en
TypeScript pour jouer avec mes amis, avec les thèmes visuels que je veux, et qui corrige les miss clicks de la
version .com.

## Lancer une partie

```sh
npm install
npm start          # build + serveur sur le port 3000 (PORT=xxxx pour changer)
```

- Toi : ouvre `http://localhost:3000`
- Ton ami (même réseau) : ouvre l'adresse `http://<ton-ip>:3000` affichée dans le terminal et dans le lobby

Le premier connecté joue Rouge, le second Bleu, les suivants regardent. Recharger la page garde sa place.

## Jouer sur traversalgame.com

Le lobby peut lancer une partie sur le site officiel :
« Contre un bot », « Matchmaking » ou « Inviter un ami » (lien d'invitation à envoyer).

- Il faut être connecté sur traversalgame.com dans **Firefox** : le serveur local réutilise cette session
  (cookies du profil Firefox, lus en local, jamais affichés).
- Le serveur local fait l'intermédiaire avec le site : il crée la partie, suit son état en direct et
  envoie tes coups. Le site reste l'arbitre : les coups légaux sont ceux qu'il fournit.
- La barre du haut affiche les pseudos et les pendules (10 min par joueur). Une proposition de nulle
  de l'adversaire ouvre une fenêtre Accepter / Refuser.
- Si ton compte a déjà une partie en cours sur le site, elle est reprise au lieu d'en créer une nouvelle.
- Pour l'instant : terrain aléatoire, parties non classées, bot de niveau 5. Pour abandonner ou proposer
  la nulle, passe par le site.

## Le jeu

- Relief continu : chaque case a un plateau plat, reliées par des pentes. Décor autour du plateau,
  murets sur les côtés, barrières de lumière rouge / bleue sur les bords à atteindre, brume.
- Personnages selon leur rôle : l'Explorateur est un éclaireur sur une chèvre avec un étendard, l'Avant-garde
  un soldat avec lance et bouclier, la Sentinelle une grosse brute. Badges de mouvement (vert) et de force
  (rouge) à leurs pieds.
- Survoler un pion affiche sa portée, quel que soit le tour : coût de déplacement peint sur les cases libres,
  bonus / malus d'attaque sur les ennemis (gris si l'attaque serait perdue).

## Commandes

- Survol d'un pion : sa portée, et sa fiche en bas à gauche
- Clic gauche : sélectionner une pièce / jouer un coup (vert = déplacement, cyan = saut d'Explorateur, rouge = attaque, flèche dorée = sortie)
- Clic gauche glissé : déplacer le plateau · Molette : zoom · Échap : désélectionner
- Clic droit glissé : tourner et incliner le plateau (la caméra et la lumière restent fixes)

Un glissé n'est jamais pris pour un clic (tolérance de 6 px), et cliquer sur une autre de tes pièces change juste la sélection.

## Code

- `shared/rules.ts` : règles, génération de terrain, coups légaux et portée (utilisé par le serveur et le client)
- `server/server.ts` : serveur HTTP + WebSocket, fait autorité sur la partie locale
- `server/official.ts` : intermédiaire avec traversalgame.com (session Firefox, création de partie, traduction des états et des coups)
- `src/flow.ts` : state machines booyah (connexion → lobby → partie → fin ; et tour : attente / sélection / envoi)
- `src/board3d.ts` : rendu three.js et sélection · `src/scenery.ts` : relief, décor, barrières · `src/characters.ts` : personnages et badges
- `src/hud.ts` : interface pixi.js
