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

### Chat et webcam

- Chat en bas à droite (Entrée pour écrire), avec des emotes Twitch / FrankerFaceZ : `:kappa:`, `:harold:`,
  `:pepefrog:`, `:feelsbadman:`, `:pepehands:`, `:pepelaugh:`, `:kekw:`, `:lulw:`, `:monkas:` (bouton grenouille pour les choisir).
- Webcam entre les deux joueurs (menu pause → « Activer la webcam »), en pair à pair (WebRTC), le serveur ne fait que
  relayer la mise en relation. Les navigateurs ne donnent la caméra qu'aux pages sécurisées : ton ami doit ouvrir
  l'adresse **https** (port 3001, `PORT + 1`), affichée dans le terminal et le lobby, et accepter l'avertissement
  du certificat auto-signé. Sur `localhost`, l'adresse http suffit.

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
- Le menu pause permet de proposer la nulle ou d'abandonner (avec confirmation).
- Pour l'instant : terrain aléatoire, parties non classées, bot de niveau 5.

## Le jeu

- Relief continu : chaque case a un plateau plat, reliées par des pentes. Décor autour du plateau,
  murets sur les côtés, barrières de lumière rouge / bleue sur les bords à atteindre, brume.
- Personnages selon leur rôle : l'Explorateur est un éclaireur sur une chèvre avec un étendard, l'Avant-garde
  un soldat avec lance et bouclier, la Sentinelle une grosse brute. Badges de mouvement (vert) et de force
  (rouge) à leurs pieds.
- Survoler un pion affiche sa portée, quel que soit le tour : coût de déplacement peint sur les cases libres,
  bonus / malus d'attaque sur les ennemis (gris si l'attaque serait perdue).
- Animations : la Sentinelle se met en boule et roule, et pour tuer elle saute sur l'ennemi, l'écrase et rebondit
  sur sa case. La chèvre de l'Explorateur saute de case en case, et pour tuer elle charge tête baissée et envoie
  l'ennemi voler. L'Avant-garde marche au pas, et pour tuer elle abaisse sa lance et se fend : l'ennemi tombe à la renverse.
- Quand l'adversaire joue, la caméra se place de trois quarts (côté terrain le plus bas, plongée de 30°), zoome sur
  le pion, attend d'être dessus pour le laisser bouger, le suit, puis revient en douceur à la vue que tu avais choisie. Son dernier coup reste marqué en orange
  (case de départ remplie, cadre autour du pion).

## Menu pause (Échap)

Reprendre · relancer la partie · échanger les camps · nouvelle partie locale sur un autre terrain · partie sur
traversalgame.com (bot, matchmaking, invitation) ou retour au local · proposer la nulle / abandonner sur le site ·
recentrer la vue · webcam et micro.

## Commandes

- Survol d'un pion : sa portée, et sa fiche en bas à gauche
- Clic gauche : sélectionner une pièce / jouer un coup (vert = déplacement, cyan = saut d'Explorateur, rouge = attaque, flèche dorée = sortie)
- Clic gauche glissé : déplacer le plateau · Molette : zoom
- Échap : désélectionner, sinon ouvrir / fermer le menu pause · Entrée : écrire dans le chat
- Clic droit glissé : tourner et incliner le plateau (la caméra et la lumière restent fixes)

Un glissé n'est jamais pris pour un clic (tolérance de 6 px), et cliquer sur une autre de tes pièces change juste la sélection.

## Code

- `shared/rules.ts` : règles, génération de terrain, coups légaux et portée (utilisé par le serveur et le client)
- `server/server.ts` : serveur HTTP + HTTPS (auto-signé, pour la webcam) + WebSocket, fait autorité sur la partie locale, relaie le chat et la signalisation WebRTC
- `server/official.ts` : intermédiaire avec traversalgame.com (session Firefox, création de partie, traduction des états et des coups)
- `src/flow.ts` : state machines booyah (connexion → lobby → partie → fin ; et tour : attente / sélection / envoi)
- `src/board3d.ts` : rendu three.js et sélection · `src/scenery.ts` : relief, décor, barrières · `src/characters.ts` : personnages et badges
- `src/hud.ts` : interface pixi.js · `src/pause.ts` : menu pause
- `src/chat.ts` : chat et emotes · `src/webcam.ts` : webcams en WebRTC
